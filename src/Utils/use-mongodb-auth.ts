import { Mutex } from 'async-mutex'
import type { Collection } from 'mongodb'
import {
	MongoNetworkError,
	MongoNetworkTimeoutError,
	MongoNotConnectedError,
	MongoOperationTimeoutError,
	MongoServerError
} from 'mongodb'
import type { Logger } from 'pino'
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

// Check if MongoDB collection is accessible
const ensureConnection = async (collection: Collection, logger?: Logger): Promise<void> => {
	try {
		// Ping the database to ensure connection is alive
		await collection.db.command({ ping: 1 })
	} catch (error) {
		logger?.error({ error }, 'MongoDB connection check failed')
		if (error instanceof MongoNotConnectedError) {
			throw new Error('MongoDB client is not connected. Please connect before using auth state.')
		}

		throw error
	}
}

/**
 * MongoDB-based authentication state storage with enhanced error handling and concurrency control
 *
 * Features:
 * - Comprehensive error handling for all MongoDB operations
 * - Mutex-based concurrency control to prevent race conditions
 * - Connection health checks before each operation
 * - Enhanced logging with trace, debug, info, warn, and error levels
 * - Full session deletion with removeCreds()
 *
 * @param collection - MongoDB collection for storing auth data
 * @param logger - Optional Pino logger for detailed operation logging
 * @returns Authentication state object with state, saveCreds, and removeCreds functions
 *
 * @example
 * ```typescript
 * const mongoClient = new MongoClient(url)
 * await mongoClient.connect()
 * const collection = mongoClient.db('whatsapp').collection('auth')
 *
 * const { state, saveCreds, removeCreds } = await useMongoDBAuthState(collection, logger)
 * ```
 */
export const useMongoDBAuthState = async (
	collection: Collection<{ id: string } & any>,
	logger?: Logger
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; removeCreds: () => Promise<void> }> => {
	const writeData = async (id: string, data: AuthenticationCreds) => {
		const mutex = getDataLock(id)

		return mutex.acquire().then(async release => {
			try {
				logger?.trace({ id }, 'acquiring lock for write operation')
				await ensureConnection(collection, logger)
				logger?.debug({ id, dataKeys: Object.keys(data) }, 'writing data to MongoDB')

				await collection.replaceOne(
					{ id },
					{ id, ...JSON.parse(JSON.stringify(data, BufferJSON.replacer)) }, // complete replace instead of partial
					{ upsert: true }
				)

				logger?.trace({ id }, 'write operation completed successfully')
			} catch (error) {
				logger?.error({ id, error }, 'failed to write data to MongoDB')

				if (error instanceof MongoNetworkError || error instanceof MongoNetworkTimeoutError) {
					throw new Error(`MongoDB network error while writing ${id}: ${(error as Error).message}`)
				} else if (error instanceof MongoServerError) {
					throw new Error(`MongoDB server error while writing ${id}: ${(error as Error).message}`)
				} else if (error instanceof MongoOperationTimeoutError) {
					throw new Error(`MongoDB operation timeout while writing ${id}: ${(error as Error).message}`)
				}

				throw error
			} finally {
				release()
			}
		})
	}

	const readData = async (id: string): Promise<any | null> => {
		const mutex = getDataLock(id)

		return mutex.acquire().then(async release => {
			try {
				logger?.trace({ id }, 'acquiring lock for read operation')
				await ensureConnection(collection, logger)
				logger?.debug({ id }, 'reading data from MongoDB')

				const data = await collection.findOne({ id }, { projection: { _id: 0, id: 0 } })

				if (data) {
					logger?.trace({ id, found: true }, 'data found in MongoDB')
					return JSON.parse(JSON.stringify(data), BufferJSON.reviver)
				} else {
					logger?.trace({ id, found: false }, 'data not found in MongoDB')
					return null
				}
			} catch (error) {
				logger?.error({ id, error }, 'failed to read data from MongoDB')

				if (error instanceof MongoNetworkError || error instanceof MongoNetworkTimeoutError) {
					logger?.warn({ id }, 'network error during read, returning null')
					return null
				} else if (error instanceof MongoServerError) {
					logger?.warn({ id }, 'server error during read, returning null')
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
				await ensureConnection(collection, logger)
				logger?.debug({ id }, 'removing data from MongoDB')

				const result = await collection.deleteOne({ id })

				logger?.trace({ id, deletedCount: result.deletedCount }, 'remove operation completed')
			} catch (error) {
				logger?.error({ id, error }, 'failed to remove data from MongoDB')

				if (error instanceof MongoNetworkError || error instanceof MongoNetworkTimeoutError) {
					logger?.warn({ id }, 'network error during remove, ignoring')
				} else if (error instanceof MongoServerError) {
					logger?.warn({ id }, 'server error during remove, ignoring')
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
		await ensureConnection(collection, logger)
		logger?.debug('MongoDB connection verified successfully')
	} catch (error) {
		logger?.error({ error }, 'failed to verify MongoDB connection during initialization')
		throw error
	}

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids: string[]) => {
					logger?.debug({ type, idsCount: ids.length }, 'getting multiple data items')
					logger?.trace({ type, ids }, 'getting data with ids')

					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}

					try {
						await Promise.all(
							ids.map(async id => {
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
												await writeData(key, value as AuthenticationCreds)
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
				logger?.debug('saving credentials to MongoDB')
				logger?.trace({ credsKeys: Object.keys(creds) }, 'saving creds with keys')
				await writeData('creds', creds)
				logger?.trace('credentials saved successfully')
			} catch (error) {
				logger?.error({ error }, 'failed to save credentials')
				throw new Error(
					`Failed to save credentials to MongoDB: ${error instanceof Error ? error.message : 'unknown error'}`
				)
			}
		},

		removeCreds: async () => {
			try {
				logger?.info('removing all authentication data from MongoDB (full session deletion)')

				// Get all documents that match the session pattern
				// Query for all documents to ensure complete cleanup
				const cursor = collection.find({})
				const docs = await cursor.toArray()

				logger?.debug({ documentCount: docs.length }, 'found documents to remove')

				const tasks: Promise<void>[] = []
				for (const doc of docs) {
					if (doc.id) {
						tasks.push(removeData(doc.id as string))
					}
				}

				await Promise.all(tasks)
				logger?.info({ removedCount: docs.length }, 'successfully removed all authentication data')
			} catch (error) {
				logger?.error({ error }, 'failed to remove credentials')
				throw new Error(
					`Failed to remove credentials from MongoDB: ${error instanceof Error ? error.message : 'unknown error'}`
				)
			}
		}
	}
}
