/**
 * Using Redis to store login data
 * Modified from @kreivc (https://www.kreivc.com/)
 * Enhanced with error handling, mutex locks, and connection health checks
 */

import { Mutex } from 'async-mutex'
import type { Logger } from 'pino'
import { createClient } from 'redis'
import { proto } from '../../WAProto'
import { type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

// Map to store mutexes for each data key to prevent concurrent access issues
const dataLocks = new Map<string, Mutex>()

// Get or create a mutex for a specific data key
const getDataLock = (key: string): Mutex => {
	let mutex = dataLocks.get(key)
	if (!mutex) {
		mutex = new Mutex()
		dataLocks.set(key, mutex)
	}

	return mutex
}

// Check if Redis client is connected and ready
const ensureConnection = async (redis: ReturnType<typeof createClient>, logger?: Logger): Promise<void> => {
	try {
		if (!redis.isReady) {
			logger?.warn('Redis client not ready, attempting to connect')
			await redis.connect()
		}

		// Verify connection with ping
		await redis.ping()
	} catch (error) {
		logger?.error({ error }, 'Redis connection check failed')
		throw new Error(`Redis connection error: ${error instanceof Error ? error.message : 'unknown error'}`)
	}
}

/**
 * Redis-based authentication state storage with enhanced error handling and concurrency control
 *
 * Features:
 * - Comprehensive error handling for all Redis operations
 * - Mutex-based concurrency control to prevent race conditions
 * - Connection health checks before each operation
 * - Enhanced logging with trace, debug, info, warn, and error levels
 * - Full session deletion with removeCreds()
 *
 * @param redis - Redis client instance
 * @param authKey - Redis hash key for storing auth data (default: 'auth')
 * @param logger - Optional Pino logger for detailed operation logging
 * @returns Authentication state object with state, saveCreds, and removeCreds functions
 *
 * @example
 * ```typescript
 * const client = createClient({ url: 'redis://localhost:6379' })
 * await client.connect()
 *
 * const { state, saveCreds, removeCreds } = await useRedisAuthState(client, 'auth', logger)
 * ```
 */
export const useRedisAuthState = async (
	redis: ReturnType<typeof createClient>,
	authKey = 'auth',
	logger?: Logger
): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	removeCreds: () => Promise<void>
}> => {
	const writeData = async (id: string, data: AuthenticationCreds & any) => {
		const mutex = getDataLock(id)

		return mutex.acquire().then(async release => {
			try {
				logger?.trace({ id }, 'acquiring lock for write operation')
				await ensureConnection(redis, logger)
				logger?.debug({ id, dataKeys: Object.keys(data) }, 'writing data to Redis')

				await redis.hSet(authKey, id, JSON.stringify(data, BufferJSON.replacer))

				logger?.trace({ id }, 'write operation completed successfully')
			} catch (error) {
				logger?.error({ id, error }, 'failed to write data to Redis')

				// Redis errors typically have error.message
				const errorMessage = error instanceof Error ? error.message : 'unknown error'

				if (errorMessage.includes('READONLY') || errorMessage.includes('LOADING')) {
					throw new Error(`Redis not ready for writes (${id}): ${errorMessage}`)
				} else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
					throw new Error(`Redis timeout while writing ${id}: ${errorMessage}`)
				} else if (errorMessage.includes('closed') || errorMessage.includes('ECONNREFUSED')) {
					throw new Error(`Redis connection error while writing ${id}: ${errorMessage}`)
				}

				throw error
			} finally {
				release()
			}
		})
	}

	const readData = async (id: string) => {
		const mutex = getDataLock(id)

		return mutex.acquire().then(async release => {
			try {
				logger?.trace({ id }, 'acquiring lock for read operation')
				await ensureConnection(redis, logger)
				logger?.debug({ id }, 'reading data from Redis')

				const data = await redis.hGet(authKey, id)

				if (data) {
					logger?.trace({ id, found: true, dataLength: data.length }, 'data found in Redis')
					return JSON.parse(data, BufferJSON.reviver)
				} else {
					logger?.trace({ id, found: false }, 'data not found in Redis')
					return null
				}
			} catch (error) {
				logger?.error({ id, error }, 'failed to read data from Redis')

				const errorMessage = error instanceof Error ? error.message : 'unknown error'

				if (errorMessage.includes('timeout') || errorMessage.includes('closed')) {
					logger?.warn({ id }, 'connection error during read, returning null')
					return null
				}

				// For other errors, return null to allow graceful degradation
				return null
			} finally {
				release()
			}
		})
	}

	const removeData = async (id: string) => {
		const mutex = getDataLock(id)

		return mutex.acquire().then(async release => {
			try {
				logger?.trace({ id }, 'acquiring lock for remove operation')
				await ensureConnection(redis, logger)
				logger?.debug({ id }, 'removing data from Redis')

				const result = await redis.hDel(authKey, id)

				logger?.trace({ id, deletedCount: result }, 'remove operation completed')
			} catch (error) {
				logger?.error({ id, error }, 'failed to remove data from Redis')

				const errorMessage = error instanceof Error ? error.message : 'unknown error'

				if (errorMessage.includes('timeout') || errorMessage.includes('closed')) {
					logger?.warn({ id }, 'connection error during remove, ignoring')
				}

				// Silently ignore errors in removal (matches multi-file pattern)
			} finally {
				release()
			}
		})
	}

	const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds()

	// Verify connection on initialization
	try {
		await ensureConnection(redis, logger)
		logger?.debug('Redis connection verified successfully')
	} catch (error) {
		logger?.error({ error }, 'failed to verify Redis connection during initialization')
		throw error
	}

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					logger?.debug({ type, idsCount: ids.length }, 'getting multiple data items')
					logger?.trace({ type, ids }, 'getting data with ids')

					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}

					try {
						await Promise.all(
							ids.map(async (id: string | number) => {
								try {
									let value = await readData(`${type}-${id}`)
									if (type === 'app-state-sync-key' && value) {
										value = proto.Message.AppStateSyncKeyData.fromObject(value)
									}

									data[id] = value
								} catch (error) {
									logger?.warn({ type, id, error }, 'failed to get single data item, skipping')
									// Continue with other items even if one fails
								}
							})
						)

						logger?.trace({ type, retrievedCount: Object.keys(data).length }, 'get operation completed')
					} catch (error) {
						logger?.error({ type, ids, error }, 'failed to get data items')
						throw error
					}

					return data
				},
				set: async data => {
					const categories = Object.keys(data)
					logger?.debug({ categories, totalKeys: categories.length }, 'setting data')
					logger?.trace({ data }, 'setting data with full content')

					try {
						const tasks: Promise<void>[] = []

						for (const category in data) {
							for (const id in data[category as keyof typeof data]) {
								const value = data[category as keyof typeof data]?.[id]
								const key = `${category}-${id}`

								tasks.push(
									(async () => {
										try {
											if (value) {
												await writeData(key, value)
											} else {
												await removeData(key)
											}
										} catch (error) {
											logger?.error({ category, id, key, error }, 'failed to set individual data item')
											throw error
										}
									})()
								)
							}
						}

						await Promise.all(tasks)
						logger?.trace({ categories }, 'set operation completed successfully')
					} catch (error) {
						logger?.error({ categories, error }, 'failed to set data')
						throw error
					}
				}
			}
		},
		saveCreds: async () => {
			try {
				logger?.debug('saving credentials to Redis')
				logger?.trace({ credsKeys: Object.keys(creds) }, 'saving creds with keys')
				await writeData('creds', creds)
				logger?.trace('credentials saved successfully')
			} catch (error) {
				logger?.error({ error }, 'failed to save credentials')
				throw new Error(
					`Failed to save credentials to Redis: ${error instanceof Error ? error.message : 'unknown error'}`
				)
			}
		},
		removeCreds: async () => {
			try {
				logger?.info('removing all authentication data from Redis (full session deletion)')
				await ensureConnection(redis, logger)

				// Delete the entire hash - this removes all session data
				const result = await redis.del(authKey)

				logger?.info({ deletedKeys: result }, 'successfully removed all authentication data')
			} catch (error) {
				logger?.error({ error }, 'failed to remove credentials')
				throw new Error(
					`Failed to remove credentials from Redis: ${error instanceof Error ? error.message : 'unknown error'}`
				)
			}
		}
	}
}
