/**
	Using Redis to store login data
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
	authKey: string = 'auth',
	logger?: Logger
): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	removeCreds: () => Promise<void>
}> => {
	const writeData = async(id: string, data: AuthenticationCreds) => {
		logger?.debug({ id, data }, 'writing data')
		
		await redis.hSet(
			authKey,
			id,
			JSON.stringify(data, BufferJSON.replacer)
		)
	}

	const readData = async(id: string) => {
		const data = await redis.hGet(authKey, id)
		logger?.debug({ id, data }, 'reading data')

		return data ? JSON.parse(data, BufferJSON.reviver) : null
	}

	const creds: AuthenticationCreds =
		(await readData('creds')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async(type, ids) => {
					logger?.debug({ ids, type }, 'getting data')
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async(id: string | number) => {
							let value = await readData(`${type}-${id}`)
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
							const key = `${category}-${id}`
							tasks.push(
								value
									? redis.hSet(
										authKey,
										key,
										JSON.stringify(value, BufferJSON.replacer)
									)
									: redis.hDel(authKey, key)
							)
						}
					}

					await Promise.all(tasks)
				},
			},
		},
		saveCreds: async() => {
			logger?.debug({ creds }, 'saving creds')
			await writeData('creds', creds)
		},
		removeCreds: async() => {
			logger?.debug('deleting creds')
			await redis.del(authKey)
		},
	}
}

