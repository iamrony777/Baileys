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
			}

			if (events['labels.association']) {
				console.log(events['labels.association'])
			}


			if (events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if (events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if (events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if (!!upsert.requestId) {
					console.log("placeholder message received for request of id=" + upsert.requestId, upsert)
				}



				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
							const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
							if (text == "requestPlaceholder" && !upsert.requestId) {
								const messageId = await sock.requestPlaceholderResend(msg.key)
								console.log('requested placeholder resync, id=', messageId)
							}

							// go to an old chat and send this
							if (text == "onDemandHistSync") {
								const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
								console.log('requested on-demand sync, id=', messageId)
							}

							if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {

								console.log('replying to', msg.key.remoteJid)
								await sock!.readMessages([msg.key])
								await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if (events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

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

			if (events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if (events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if (events['presence.update']) {
				console.log(events['presence.update'])
			}

			if (events['chats.update']) {
				console.log(events['chats.update'])
			}

			if (events['contacts.update']) {
				for (const contact of events['contacts.update']) {
					if (typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if (events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}

			if (events['group.member-tag.update']) {
				console.log('group member tag update', JSON.stringify(events['group.member-tag.update'], undefined, 2))
			}
		}
	)
	return sock;
}

startSock();