import { Boom } from '@hapi/boom'
import fs from 'fs'
import { MongoClient } from 'mongodb'
import NodeCache from 'node-cache'
import readline from 'readline'
import 'dotenv/config'
import makeWASocket, {
	AnyMessageContent,
	Browsers,
	delay,
	DisconnectReason,
	fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage,
	makeCacheableSignalKeyStore,
	makeMongoStore,
	PHONENUMBER_MCC,
	proto,
	useMongoDBAuthState,
	WAMessageContent,
	WAMessageKey } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
const logger = MAIN_LOGGER.child({})
logger.level = 'debug'

import * as Sentry from '@sentry/node'
import { ProfilingIntegration } from '@sentry/profiling-node'

if(process.env.SENTRY_DSN) {
	logger.info('Sentry enabled')
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		integrations: [
		  new ProfilingIntegration(),
		],
		// Performance Monitoring
		tracesSampleRate: 1.0,
		// Set sampling rate for profiling - this is relative to tracesSampleRate
		profilesSampleRate: 1.0,
	  })
}


const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
})
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
// const store = useStore ? makeInMemoryStore({ logger }) : undefined
// store?.readFromFile('./baileys_store_multi.json')
// // // // // save every 10s
// setInterval(() => {
// 	store?.writeToFile('./baileys_store_multi.json')
// }, 10_000)

// start a connection

const startSock = async() => {
	// const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	// // Use mongodb to store auth info
	const mongoClient = new MongoClient(process.env.MONGODB_URL as string, { socketTimeoutMS: 1_00_000, connectTimeoutMS: 1_00_000, waitQueueTimeoutMS: 1_00_000 })
	await mongoClient.connect()
	const { state, saveCreds } = await useMongoDBAuthState(mongoClient.db('whatsapp-sessions').collection('client'))
	const store = useStore
		? makeMongoStore({ filterChats: true, logger, db: mongoClient.db('whatsapp-sessions') })
		: undefined
	// await store?.readFromDb('store')
	// setInterval(async() => {
	// 	await store?.writeToDb('store')
	// }, 60 * 1000)

	// Use Redis to store auth info, and multiauthstore to store other data
	// const url = new URL(process.env.REDIS_URL!)
	// const client = createClient({
	// 	url: url.href,
	// 	database: url.protocol === 'rediss:' ? 0 : 1,
	// })
	// await client.connect()
	// const { state, saveCreds } = await useRedisAuthState(client, 'store', logger)
	// const store = useStore
	// 	? makeRedisStore({ logger, redis: client })
	// 	: undefined
	// await store?.readFromDb()
	// setInterval(async() => {
	// 	await store?.uploadToDb()
	// }, 60 * 1000)

	const sock = makeWASocket({
		version,
		defaultQueryTimeoutMs: undefined,
		logger,
		browser: Browsers.baileys('desktop'),
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		shouldSyncHistoryMessage: () => true,
		syncFullHistory: true,
		getMessage,
	})

	store?.bind(sock.ev)

	// Pairing code for Web clients
	if(usePairingCode && !sock.authState.creds.registered) {
		if(useMobile) {
			throw new Error('Cannot use pairing code with mobile api')
		}

		const phoneNumber = await question(
			'Please enter your mobile phone number:\n'
		)
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	// If mobile was chosen, ask for the code
	if(useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if(!registration.phoneNumber) {
			registration.phoneNumber = await question(
				'Please enter your mobile phone number:\n'
			)
		}

		const libPhonenumber = await import('libphonenumber-js')
		const phoneNumber = libPhonenumber.parsePhoneNumber(
			registration.phoneNumber
		)
		if(!phoneNumber?.isValid()) {
			throw new Error('Invalid phone number: ' + registration.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if(!mcc) {
			throw new Error(
				'Could not find MCC for phone number: ' +
				registration.phoneNumber +
				'\nPlease specify the MCC manually.'
			)
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Please enter the one time code:\n')
				const response = await sock.register(
					code.replace(/["']/g, '').trim().toLowerCase()
				)
				console.log('Successfully registered your phone number.')
				console.log(response)
				rl.close()
			} catch(error) {
				console.error(
					'Failed to register your phone number. Please try again.\n',
					error
				)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({
				...registration,
				method: 'captcha',
			})
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

			open(path)
			const code = await question('Please enter the captcha code:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if(!registration.method) {
				let code = await question(
					'How would you like to receive the one time code for registration? "sms" or "voice"\n'
				)
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if(code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch(error) {
				console.error(
					'Failed to request registration code. Please try again.\n',
					error
				)

				if(error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if(
						(lastDisconnect?.error as Boom)?.output?.statusCode !==
						DisconnectReason.loggedOut
					) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
						await mongoClient.db('whatsapp-sessions').dropDatabase()
						startSock()

					}
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events['labels.association']) {
				console.log(events['labels.association'])
			}

			if(events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if(events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } =
					events['messaging-history.set']
				console.log(
					`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`
				)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if(upsert.type === 'notify') {
					for(const msg of upsert.messages) {
						if(!msg.key.fromMe && doReplies) {
							console.log('replying to', msg.key.remoteJid)
							await sock.readMessages([msg.key])
							sock.sendMessage(
								msg.key.remoteJid!,
								{
									text: 'Hi',
								},
								{ ephemeralExpiration: 1 * 60 }
							)
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log(JSON.stringify(events['messages.update'], undefined, 2))

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation = await getMessage(key)
						if(pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if(events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const update of events['contacts.update']) {

					if(update.imgUrl === 'changed') {
						const contact = await store?.getContactInfo(update.id!, sock)
						console.log(
							`contact ${contact?.name} ${contact?.id} has a new profile pic: ${contact?.imgUrl}`
						)
					}
				}
			}

			if(events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(
		key: WAMessageKey
	): Promise<WAMessageContent | undefined> {
		if(store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}

try {
	startSock()
} catch(e) {
	startSock()
}
