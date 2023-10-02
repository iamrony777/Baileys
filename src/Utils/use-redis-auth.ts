/**
	Using Redis to store `auth`,`state`
	Original Author @kreivc (https://www.kreivc.com/)
*/

import type { Logger } from 'pino'
import { createClient } from 'redis'
import { proto } from '../../WAProto'
import {
	AuthenticationCreds,
	AuthenticationState,
	SignalDataTypeMap,
} from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'


export const useRedisAuthState = async(
	redis: ReturnType<typeof createClient>,
	prefix = 'wp',
	logger?: Logger
): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	removeCreds: () => Promise<void>
}> => {
	// TODO: im using ioredis (www.npmjs.com/package/ioredis). replace with redis library from (www.npmjs.com/package/redis)
	const createKey = (key: string, prefix: string) => `${key}:${prefix}`
	const writeData = async(key: string, field: string, data: any) => {
		logger?.debug({ key: createKey(key, prefix), field, data }, 'writing data')

		await redis.hSet(
			createKey(key, prefix),
			field,
			JSON.stringify(data, BufferJSON.replacer)
		)
	}

	const readData = async(key: string, field: string) => {
		const data = await redis.hGet(createKey(key, prefix), field)
		logger?.debug({ key: createKey(key, prefix), data }, 'reading data')

		return data ? JSON.parse(data, BufferJSON.reviver) : null
	}

	const deleteData = async(key: string) => await redis.del(createKey('authState', key))

	const creds: AuthenticationCreds =
		(await readData('authState', 'creds')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async(type, ids) => {
					logger?.debug({ ids, type }, 'getting data')
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async(id: string | number) => {
							let value = await readData('authState', `${type}-${id}`)
							if(type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						})
					)
					return data
				},
				set: async(data: any) => {
					logger?.debug({ data }, 'setting data')
					const tasks: Promise<number>[] = []
					for(const category in data) {
						for(const id in data[category]) {
							const value = data[category][id]
							const field = `${category}-${id}`
							tasks.push(
								value
									? redis.hSet(
										createKey('authState', prefix),
										field,
										JSON.stringify(value, BufferJSON.replacer)
									)
									: redis.hDel(createKey('authState', prefix), field)
							)
						}
					}

					await Promise.all(tasks)
				},
			},
		},
		saveCreds: async() => {
			logger?.debug({ creds }, 'saving creds')
			await writeData('authState', 'creds', creds)
		},
		removeCreds: async() => {
			logger?.debug('deleting creds')
			await deleteData('authState')
		},
	}
}

