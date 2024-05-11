# Baileys - Typescript/Javascript WhatsApp Web API

## About this Fork
The original repository was removed by its author and later taken over by [WhiskeySockets](https://github.com/WhiskeySockets). This current fork is based on that. I've only made additions such as custom stores for storing authentication, messages, etc., and merged a few pull requests. That's all.


**If you encounter any issues after using this fork or any part of it, I recommend creating a new issue here rather than on WhiskeySocket's Discord server. AND EXPECT BUGS, LOTS OF BUGS (THIS IS UNSTABLE ASF)**

[NPM Package](https://www.npmjs.com/package/@iamrony777/baileys)

## Installation

Check `.env.example` first to setup databases
 

```bash
yarn install @iamrony777/baileys
```
or
```bash
yarn github:iamrony777/Baileys ## Directly from github repo
```

Then import your code using:
``` ts
import makeWASocket, { ... } from '@iamrony777/baileys'
```


## Connecting multi device (recommended)

### **I recommend to use Redis for storing auth data (as it is the fastest) and Mongo for storing chats, messages**

WhatsApp provides a multi-device API that allows Baileys to be authenticated as a second WhatsApp client by scanning a QR code with WhatsApp on your phone.

``` ts
import { MongoClient } from "mongodb";
import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeMongoStore,
  useMongoDBAuthState,
} from "@iamrony777/baileys";
import { Boom } from "@hapi/boom";
import "dotenv/config";

async function connectToWhatsApp() {
  // MongoDB setup
  const mongo = new MongoClient(process.env.MONGODB_URL!, {
    socketTimeoutMS: 1_00_000,
    connectTimeoutMS: 1_00_000,
    waitQueueTimeoutMS: 1_00_000,
  });
  const authCollection = mongo.db("wpsessions").collection("auth");
  const { state, saveCreds } = await useMongoDBAuthState(authCollection);
  const store = makeMongoStore({ db: mongo.db("wpsessions"), autoDeleteStatusMessage: true });

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      /** caching makes the store faster to send/recv messages */
      keys: makeCacheableSignalKeyStore(state.keys),
    },

    // can provide additional config here
    printQRInTerminal: true,
  });

  // listen on events and update database
  store.bind(sock.ev);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        "connection closed due to ",
        lastDisconnect?.error,
        ", reconnecting ",
        shouldReconnect
      );
      // reconnect if not logged out
      if (shouldReconnect) {
        await mongo.close();
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      console.log("opened connection");
      await sock.sendMessage(
        sock.user?.id!,
        {
          text: "Connected!",
        },
        { ephemeralExpiration: 1 * 60 }
      );
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    console.log(JSON.stringify(m, undefined, 2));

    // if message type is notify and not a protocol message
    if (
      m.type === "notify" &&
      !m.messages[0].message?.hasOwnProperty("protocolMessage")
    ) {
      console.log("replying to", m.messages[0].key.remoteJid);

      // await sock.sendMessage(m.messages[0].key.remoteJid!, {
      //   text: "Hello there!",
      // });
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
  });
}
// run in main file
connectToWhatsApp();

```

If the connection is successful, you will see a QR code printed on your terminal screen, scan it with WhatsApp on your phone and you'll be logged in!

**Note:** install `qrcode-terminal` using `yarn add qrcode-terminal` to auto-print the QR to the terminal.

**Note:** the code to support the legacy version of WA Web (pre multi-device) has been removed in v5. Only the standard multi-device connection is now supported. This is done as WA seems to have completely dropped support for the legacy version.


**Note:** I didn't add the search-by-contact-hash [implementation by purpshell](https://github.com/WhiskeySockets/Baileys/blob/ce325d11828b6f32584b39e7e427aa47b0ee555d/src/Store/make-in-memory-store.ts#L177-L181)  

## Custom funtions added to this package

### 1. `store?.getContactInfo(jid: string, socket: typeof makeWASocket)`

```typescript
if (events["contacts.update"]) {
  for (const update of events["contacts.update"]) {
    if (update.imgUrl === "changed") { // getting 
      const contact = await store?.getContactInfo(update.id!, sock);
      console.log(
        `contact ${contact?.name} ${contact?.id} has a new profile pic: ${contact?.imgUrl}`
      );
    }
  }
}
```




## Everything besides store and auth connectors are same as the original repo.

[Read here](https://github.com/WhiskeySockets/Baileys?tab=readme-ov-file#baileys---typescriptjavascript-whatsapp-web-api)
