import type { Comparable } from '@adiwajshing/keyed-db/lib/Types'
import { AnyBulkWriteOperation, Db } from 'mongodb'
import type { Logger } from 'pino'
import { proto } from '../../WAProto'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type makeMDSocket from '../Socket'
import type {
	BaileysEventEmitter,
	Chat,
	ConnectionState,
	Contact,
	GroupMetadata,
	PresenceData,
	WAMessage,
	WAMessageCursor,
	WAMessageKey,
} from '../Types'
import { Label } from '../Types/Label'
import {
	LabelAssociation,
	LabelAssociationType,
	MessageLabelAssociation,
} from '../Types/LabelAssociation'
import {
	toNumber,
	updateMessageWithReaction,
	updateMessageWithReceipt,
} from '../Utils'
import { jidNormalizedUser } from '../WABinary'
import makeOrderedDictionary from './make-ordered-dictionary'
import { ObjectRepository } from './object-repository'

type WASocket = ReturnType<typeof makeMDSocket>

export const waChatKey = (pin: boolean) => ({
	key: (c: Chat) =>
		(pin ? (c.pinned ? '1' : '0') : '') +
		(c.archived ? '0' : '1') +
		(c.conversationTimestamp
			? c.conversationTimestamp.toString(16).padStart(8, '0')
			: '') +
		c.id,
	compare: (k1: string, k2: string) => k2.localeCompare(k1),
})

export const waMessageID = (m: WAMessage) => m.key.id || ''

export const waLabelAssociationKey: Comparable<LabelAssociation, string> = {
	key: (la: LabelAssociation) =>
		la.type === LabelAssociationType.Chat
			? la.chatId + la.labelId
			: la.chatId + la.messageId + la.labelId,
	compare: (k1: string, k2: string) => k2.localeCompare(k1),
}

export type BaileyesMongoStoreConfig = {
	chatKey?: Comparable<Chat, string>
	labelAssociationKey?: Comparable<LabelAssociation, string>
	logger?: Logger
	db: Db
}

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID)

const predefinedLabels = Object.freeze<Record<string, Label>>({
	'0': {
		id: '0',
		name: 'New customer',
		predefinedId: '0',
		color: 0,
		deleted: false,
	},
	'1': {
		id: '1',
		name: 'New order',
		predefinedId: '1',
		color: 1,
		deleted: false,
	},
	'2': {
		id: '2',
		name: 'Pending payment',
		predefinedId: '2',
		color: 2,
		deleted: false,
	},
	'3': {
		id: '3',
		name: 'Paid',
		predefinedId: '3',
		color: 3,
		deleted: false,
	},
	'4': {
		id: '4',
		name: 'Order completed',
		predefinedId: '4',
		color: 4,
		deleted: false,
	},
})

export default ({
	logger: _logger,
	db,
	chatKey,
	labelAssociationKey,
}: BaileyesMongoStoreConfig) => {
	chatKey = chatKey || waChatKey(true)
	labelAssociationKey = labelAssociationKey || waLabelAssociationKey
	const logger =
		_logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'mongo-store' })
	const chats = db.collection<Chat>('chats')
	const messages: { [_: string]: ReturnType<typeof makeMessagesDictionary> } =
		{}
	const contacts = db.collection<Contact>('contacts')
	const groupMetadata: { [_: string]: GroupMetadata } = {}
	const presences: { [id: string]: { [participant: string]: PresenceData } } =
		{}
	const state: ConnectionState = { connection: 'close' }
	const labels = new ObjectRepository<Label>(predefinedLabels)
	const labelAssociations =
		db.collection<LabelAssociation>('labelAssociations')

	const assertMessageList = (jid: string) => {
		if (!messages[jid]) {
			messages[jid] = makeMessagesDictionary()
		}

		return messages[jid]
	}


	const labelsUpsert = (newLabels: Label[]) => {
		for (const label of newLabels) {
			labels.upsertById(label.id, label)
		}
	}

	const bind = (ev: BaileysEventEmitter, socket?: WASocket) => {
		ev.on('connection.update', (update) => {
			Object.assign(state, update)
		})

		ev.on(
			'messaging-history.set',
			async ({
				chats: newChats,
				contacts: newContacts,
				messages: newMessages,
				isLatest,
			}) => {
				if (isLatest) {
					await chats.drop()

					for (const id in messages) {
						delete messages[id]
					}
				}

				const chatsAdded = await chats.bulkWrite(
					newChats.map((chat) => ({
						updateOne: {
							filter: { id: chat.id },
							update: {$setOnInsert: chat},
							upsert: true,
						}
					}))
				)

				logger.debug({ chatsAdded: chatsAdded.insertedCount }, 'synced chats')


				const oldContacts = await contacts.bulkWrite(
					newContacts.map((contact) => ({
						updateOne: {
							filter: { id: contact.id },
							update: {$setOnInsert: contact},
							upsert: true,
						}
					}))
				);
				logger.debug(
					{ insertedContacts: oldContacts.insertedCount },
					'synced contacts'
				)

				for (const msg of newMessages) {
					const jid = msg.key.remoteJid!
					const list = assertMessageList(jid)
					list.upsert(msg, 'prepend')

					const chat = await chats.findOne({ id: jid }, { projection: { _id: 0 } })
					if (chat && chat.messages) {
						chat.messages.push({message: msg})
						await chats.updateOne(
							{ id: jid },
							{ $setOnInsert: chat },
							{ upsert: true }
						)
					} else {
						logger.debug({ jid }, 'chat not found')
					}
				}

				logger.debug({ messages: newMessages.length }, 'synced messages')
			}
		)

		ev.on('contacts.upsert', async (Contacts) => {
			await contacts.bulkWrite(Contacts.map(contact => ({
				updateOne: {
					filter: { id: contact.id },
					update: { $setOnInsert: contact },
					upsert: true
				}
			})))

		})

		ev.on('contacts.update', async (updates) => {
			for (const update of updates) {
				const contact: Partial<Contact> | null = await contacts.findOne({ id: update.id }, { projection: { _id: 0 } });

				if (contact) {
					Object.assign(contact, update);
					await contacts.updateOne({ id: update.id }, { $set: contact }, { upsert: true });
				} else {
					logger.debug({ update }, 'got update for non-existent contact');
				}

			}
		});

		ev.on('chats.upsert', async (newChats) => {
			await chats.bulkWrite(newChats.map((chat) => {
				return {
					updateOne: {
						filter: { id: chat.id },
						update: { $set: chat },
						upsert: true,
					},
				}
			}))
		})

		ev.on('chats.update', async (updates) => {
			for (const update of updates) {

				const chat = await chats.findOneAndUpdate({ id: update.id }, {
					$set: update,
				}, { upsert: true })

				if (!chat) {
					logger.debug({ update }, 'got update for non-existant chat')
				}
			}
		})

		ev.on('labels.edit', (label: Label) => {
			if (label.deleted) {
				return labels.deleteById(label.id)
			}

			// WhatsApp can store only up to 20 labels
			if (labels.count() < 20) {
				return labels.upsertById(label.id, label)
			}

			logger.error('Labels count exceed')
		})

		ev.on('labels.association', async ({ type, association }) => {
			switch (type) {
				case 'add':
					await labelAssociations.updateOne(
						{ id: association?.chatId || association?.labelId },
						{ $set: association },
						{ upsert: true }
					)
					break
				case 'remove':
					await labelAssociations.deleteOne({
						id: association?.chatId || association?.labelId,
					})
					break
				default:
					logger.error(`unknown operation type [${type}]`)
			}
		})

		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = presences[id] || {}
			Object.assign(presences[id], update)
		})

		// TODO implement mongodb
		ev.on('chats.delete', async (deletions) => {
			for (const item of deletions) {
				await chats.deleteOne({ id: item })
			}
		})

		ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
			switch (type) {
				case 'append':
				case 'notify':
					for (const msg of newMessages) {
						const jid = jidNormalizedUser(msg.key.remoteJid!)
						const list = assertMessageList(jid)
						list.upsert(msg, 'append')

						const chat = await chats.findOne({ id: jid })
						if (type === 'notify') {
							if (!chat) {
								ev.emit('chats.upsert', [
									{
										id: jid,
										conversationTimestamp: toNumber(msg.messageTimestamp),
										unreadCount: 1,
									},
								])
							} else {
								// append to existing chat
								// Database has only last meesage after loggin in.
								// this code only appends new messages of current chat
								// but doesn't contains whole message history
								// although `list.array` has the whole messages stored, I need to find a way
								// to insert `list.array` in chunk
								if (chat.messages) {
									chat.messages.push( { message: msg });
									chats.updateOne(
										{ id: jid },
										{ $set: chat },
										{ upsert: true }
									)
								} else {
									chat.messages = [{ message: msg }];
									chats.updateOne(
										{ id: jid },
										{ $set: chat },
										{ upsert: true }
									)
								}

							}
						}
					}

					break
			}
		})

		ev.on('messages.update', (updates) => {
			for (const { update, key } of updates) {
				const list = assertMessageList(jidNormalizedUser(key.remoteJid!))
				if (update?.status) {
					const listStatus = list.get(key.id!)?.status
					if (listStatus && update?.status <= listStatus) {
						logger.debug(
							{ update, storedStatus: listStatus },
							'status stored newer then update'
						)
						delete update.status
						logger.debug({ update }, 'new update object')
					}
				}

				const result = list.updateAssign(key.id!, update)
				if (!result) {
					logger.debug({ update }, 'got update for non-existent message')
				}
			}
		})

		ev.on('messages.delete', (item) => {
			if ('all' in item) {
				const list = messages[item.jid]
				list?.clear()
			} else {
				const jid = item.keys[0].remoteJid!
				const list = messages[jid]
				if (list) {
					const idSet = new Set(item.keys.map((k) => k.id))
					list.filter((m) => !idSet.has(m.key.id))
				}
			}
		})

		ev.on('groups.update', (updates) => {
			for (const update of updates) {
				const id = update.id!
				if (groupMetadata[id]) {
					Object.assign(groupMetadata[id], update)
				} else {
					logger.debug({ update }, 'got update for non-existant group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id]
			if (metadata) {
				switch (action) {
					case 'add':
						metadata.participants.push(
							...participants.map((id) => ({
								id,
								isAdmin: false,
								isSuperAdmin: false,
							}))
						)
						break
					case 'demote':
					case 'promote':
						for (const participant of metadata.participants) {
							if (participants.includes(participant.id)) {
								participant.isAdmin = action === 'promote'
							}
						}

						break
					case 'remove':
						metadata.participants = metadata.participants.filter(
							(p) => !participants.includes(p.id)
						)
						break
				}
			}
		})

		ev.on('message-receipt.update', (updates) => {
			for (const { key, receipt } of updates) {
				const obj = messages[key.remoteJid!]
				const msg = obj?.get(key.id!)
				if (msg) {
					updateMessageWithReceipt(msg, receipt)
				}
			}
		})

		ev.on('messages.reaction', (reactions) => {
			for (const { key, reaction } of reactions) {
				const obj = messages[key.remoteJid!]
				const msg = obj?.get(key.id!)
				if (msg) {
					updateMessageWithReaction(msg, reaction)
				}
			}
		})
	}

	const toJSON = () => ({
		chats,
		contacts,
		messages,
		labels,
		labelAssociations,
	})

	// TODO: replace upsert logic by corresponding mongodb collection methods
	const fromJSON = async (json: {
		chats: Chat[]
		contacts: { [id: string]: Contact }
		messages: { [id: string]: WAMessage[] }
		labels: { [labelId: string]: Label }
		labelAssociations: LabelAssociation[]
	}) => {
		await chats.updateMany({}, { $set: { ...json.chats } }, { upsert: true })
		await labelAssociations.updateMany(
			{},
			{ $set: { ...(json.labelAssociations || []) } },
			{ upsert: true }
		)

		const contactsCollection = db.collection<Contact>('contacts')
		await contactsCollection.updateMany({}, { $set: { ...Object.values(json.contacts) } }, { upsert: true })

		// contactsUpsert(Object.values(json.contacts))
		labelsUpsert(Object.values(json.labels || {}))
		for (const jid in json.messages) {
			const list = assertMessageList(jid)
			for (const msg of json.messages[jid]) {
				list.upsert(proto.WebMessageInfo.fromObject(msg), 'append')
			}
		}
	}

	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		state,
		presences,
		labels,
		labelAssociations,
		bind,
		/** loads messages from the store, if not found -- uses the legacy connection */
		loadMessages: async (
			jid: string,
			count: number,
			cursor: WAMessageCursor
		) => {
			const list = assertMessageList(jid)
			const mode = !cursor || 'before' in cursor ? 'before' : 'after'
			const cursorKey = !!cursor
				? 'before' in cursor
					? cursor.before
					: cursor.after
				: undefined
			const cursorValue = cursorKey ? list.get(cursorKey.id!) : undefined

			let messages: WAMessage[]
			if (list && mode === 'before' && (!cursorKey || cursorValue)) {
				if (cursorValue) {
					const msgIdx = list.array.findIndex((m) => m.key.id === cursorKey?.id)
					messages = list.array.slice(0, msgIdx)
				} else {
					messages = list.array
				}

				const diff = count - messages.length
				if (diff < 0) {
					messages = messages.slice(-count) // get the last X messages
				}
			} else {
				messages = []
			}

			return messages
		},
		/**
		 * Get all available labels for profile
		 *
		 * Keep in mind that the list is formed from predefined tags and tags
		 * that were "caught" during their editing.
		 */
		getLabels: () => {
			return labels
		},

		/**
		 * Get labels for chat
		 *
		 * @returns Label IDs
		 **/
		getChatLabels: (chatId: string) => {
			return labelAssociations.findOne(
				(la: { chatId: string }) => la.chatId === chatId
			)
		},

		/**
		 * Get labels for message
		 *
		 * @returns Label IDs
		 **/
		getMessageLabels: async (messageId: string) => {
			const associations = labelAssociations.find(
				(la: MessageLabelAssociation) => la.messageId === messageId
			)

			return associations?.map(({ labelId }) => labelId)
		},
		loadMessage: async (jid: string, id: string) => messages[jid]?.get(id),
		mostRecentMessage: async (jid: string) => {
			const message: WAMessage | undefined = messages[jid]?.array.slice(-1)[0]
			return message
		},
		fetchImageUrl: async (jid: string, sock: WASocket | undefined) => {
			const contact = await contacts.findOne({ id: jid }, { projection: { _id: 0 } })
			if (!contact) {
				return sock?.profilePictureUrl(jid)
			}

			if (typeof contact.imgUrl === 'undefined') {
				contact.imgUrl = await sock?.profilePictureUrl(jid)
				await contacts.updateOne({ id: jid }, { $set: contact }, { upsert: true })
			}

			return contact.imgUrl
		},
		getContactInfo: async (jid: string, socket: WASocket): Promise<Partial<Contact> | null> => {

			const contact: Partial<Contact> | null = await contacts.findOne({ id: jid }, { projection: { _id: 0 } })

			if (!contact) {
				return {
					id: jid,
					imgUrl: await socket?.profilePictureUrl(jid),
				}
			}

			// fetch image if required
			if (typeof contact.imgUrl === 'undefined' || contact.imgUrl === 'changed') {
				contact.imgUrl = await socket?.profilePictureUrl(contact.id!, 'image')
				await contacts.updateOne({ id: jid }, { $set: { ...contact } }, { upsert: true })
			}

			return contact

		},
		fetchGroupMetadata: async (jid: string, sock: WASocket | undefined) => {
			if (!groupMetadata[jid]) {
				const metadata = await sock?.groupMetadata(jid)
				if (metadata) {
					groupMetadata[jid] = metadata
				}
			}

			return groupMetadata[jid]
		},

		fetchMessageReceipts: async ({ remoteJid, id }: WAMessageKey) => {
			const list = messages[remoteJid!]
			const msg = list?.get(id!)
			return msg?.userReceipt
		},
		toJSON,
		fromJSON,
	}
}
