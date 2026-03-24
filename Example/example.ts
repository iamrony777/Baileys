import type { Boom } from "@hapi/boom";
import { MongoClient } from "mongodb";
import NodeCache from '@cacheable/node-cache'
import readline from "node:readline";
import "dotenv/config";
import makeWASocket, {
	type AnyMessageContent,
	BinaryInfo,
	Browsers,
	delay,
	DisconnectReason,
	encodeWAM,
	fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage,
	makeCacheableSignalKeyStore, addTransactionCapability,
	makeMongoStore, // mongo store
	proto,
	useMongoDBAuthState, // mongo auth
	useRedisAuthState, // redis auth
	type WAMessageContent,
	type WAMessageKey,
	isJidNewsletter,
	CacheStore,
	generateMessageIDV2,
 DEFAULT_CONNECTION_CONFIG
} from "../src";
import { makeLibSignalRepository } from "../src/Signal/libsignal";
import MAIN_LOGGER from "../src/Utils/logger";
import qrcode from "qrcode-terminal";
import open from "open";
import P from "pino";
import { createClient } from "redis";

const logger = P({
	level: "trace",
	transport: {
		targets: [
			{
				target: "pino-pretty", // pretty-print for console
				options: { colorize: true },
				level: "trace",
			},
			{
				target: "pino/file", // raw file output
				options: { destination: './wa-logs.txt' },
				level: "trace",
			},
		],
	},
})
logger.level = 'trace'

const useStore = !process.argv.includes("--no-store");
const doReplies = process.argv.includes("--do-reply");
const usePairingCode = process.argv.includes("--use-pairing-code");
const useMobile = process.argv.includes("--mobile");

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore


// Read line interface
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});
const question = (text: string) =>
	new Promise<string>((resolve) => rl.question(text, resolve));

// start a connection

const startSock = async () => {
	// const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion();
	console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
	// // Use mongodb to store auth info
	const mongoClient = new MongoClient(process.env.MONGODB_URL as string, {
		socketTimeoutMS: 1_00_000,
		connectTimeoutMS: 1_00_000,
		waitQueueTimeoutMS: 1_00_000,
	});
	await mongoClient.connect();

	// // or use redis to store auth info
	const url = new URL(process.env.REDIS_URL!);
	const client = createClient({
		url: url.href,
		database: url.protocol === "rediss:" ? 0 : 1,
	});
	await client.connect();


	// // get props from redis
	const { state, saveCreds, removeCreds } = await useRedisAuthState(client);

	// // get props from mongodb
	// const { state, saveCreds, removeCreds } = await useMongoDBAuthState(
	// 	mongoClient.db("whatsapp-sessions").collection("client")
	// );
	const store = useStore
		? makeMongoStore({
			filterChats: true,
			logger,
			db: mongoClient.db("whatsapp-sessions"),
			// autoDeleteStatusMessage: {
			//   cronTime: "*/1 * * * *",
			//   timeZone: "Asia/Kolkata",
			// },
			autoDeleteStatusMessage: true,

		})
		: undefined;
	// Use Redis to store auth info, and multiauthstore to store other data

	// const store = useStore
	// 	? makeRedisStore({ logger, redis: client })
	// 	: undefined
	// await store?.readFromDb()
	// setInterval(async() => {
	// 	await store?.uploadToDb()
	// }, 60 * 1000)

	async function getMessage(
		key: WAMessageKey,
	): Promise<WAMessageContent | undefined> {
		if (store && key.id && key.remoteJid) {
			const msg = await store.loadMessage(key.remoteJid, key.id);
			return msg?.message || undefined;
		}

		// only if store is not present
		return proto.Message.fromObject({});
	}
	const auth = {
		creds: state.creds,
		/** caching makes the store faster to send/recv messages */
		keys: addTransactionCapability(makeCacheableSignalKeyStore(state.keys, logger), logger, { maxCommitRetries: 3, delayBetweenTriesMs: 1000 }),
	}
	const sock = makeWASocket({
		version,
		defaultQueryTimeoutMs: undefined, logger,
		browser: Browsers.baileys("desktop"),
		auth,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		msgRetryCounterCache,
		markOnlineOnConnect: false,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		shouldSyncHistoryMessage: () => true,
		syncFullHistory: true,

		getMessage,
		makeSignalRepository: () => {
			return makeLibSignalRepository(auth, logger)
		},
	});
	store?.bind(sock.ev);


	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question("Please enter your phone number:\n");
		const code = await sock.requestPairingCode(phoneNumber);
		console.log(`Pairing code: ${code}`);
	}

	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid);
		await delay(500);

		await sock.sendPresenceUpdate("paused", jid);

		await sock.sendMessage(jid, msg);
	};

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async (events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if (connection === 'close') {
					// reconnect if not logged out
					if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
						await removeCreds()
						client.destroy()
						await mongoClient.close()
						process.exit(0)
					}
				}

				if (qr) {
					qrcode.generate(qr, { small: true }, (qrCode) => {
						console.log("QR received, scan it with your phone");
						console.log(qrCode);
					  });
					
				}
				console.log('connection update', update)
			}

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
				logger.debug({}, 'creds save triggered')
			}

			if(events['labels.association']) {
				logger.debug(events['labels.association'], 'labels.association event fired')
			}


			if(events['labels.edit']) {
				logger.debug(events['labels.edit'], 'labels.edit event fired')
			}

			if(events['call']) {
				logger.debug(events['call'], 'call event fired')
			}

			// history received
			if (events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					logger.debug(messages, 'received on-demand history sync')
				}
				logger.debug({contacts: contacts.length, chats: chats.length, messages: messages.length, isLatest, progress, syncType: syncType?.toString() }, 'messaging-history.set event fired')
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.debug(upsert, 'messages.upsert fired')

        if (!!upsert.requestId) {
          logger.debug(upsert, 'placeholder request message received')
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
								logger.debug({ id: messageId }, 'requested placeholder resync')
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                logger.debug({ id: messageId }, 'requested on-demand history resync')
              }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
              	const id = generateMessageIDV2(sock.user?.id)
              	logger.debug({id, orig_id: msg.key.id }, 'replying to message')
                await sock.sendMessage(msg.key.remoteJid!, { text: 'pong '+msg.key.id }, {messageId: id })
              }
            }
          }
        }
      }

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				logger.debug(events['messages.update'], 'messages.update fired')

				for (const { key, update } of events['messages.update']) {
					if (update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if (pollCreation) {
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
				logger.debug(events['message-receipt.update'])
			}

			if (events['contacts.upsert']) {
				logger.debug(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				logger.debug(events['messages.reaction'])
			}

			if(events['presence.update']) {
				logger.debug(events['presence.update'])
			}

			if(events['chats.update']) {
				logger.debug(events['chats.update'])
			}

			if (events['contacts.update']) {
				for (const contact of events['contacts.update']) {
					if (typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						logger.debug({id: contact.id, newUrl}, `contact has a new profile pic` )
					}
				}
			}

			if(events['chats.delete']) {
				logger.debug('chats deleted ', events['chats.delete'])
			}

			if(events['group.member-tag.update']) {
				logger.debug('group member tag update', JSON.stringify(events['group.member-tag.update'], undefined, 2))
			}
		}
	)
	return sock;
}

startSock();