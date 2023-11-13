import type { Comparable } from "@adiwajshing/keyed-db/lib/Types";
import { Db } from "mongodb";
import type { Logger } from "pino";
import { proto } from "../../WAProto";
import { DEFAULT_CONNECTION_CONFIG } from "../Defaults";
import type makeMDSocket from "../Socket";
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
} from "../Types";
import { Label } from "../Types/Label";
import {
  LabelAssociation,
  LabelAssociationType,
  MessageLabelAssociation,
} from "../Types/LabelAssociation";
import {
  toNumber,
  updateMessageWithReaction,
  updateMessageWithReceipt,
} from "../Utils";
import { jidNormalizedUser } from "../WABinary";
import makeOrderedDictionary from "./make-ordered-dictionary";
import { ObjectRepository } from "./object-repository";
import { CronJob, CronTime } from "cron";
import moment from "moment-timezone";

type WASocket = ReturnType<typeof makeMDSocket>;

export const waChatKey = (pin: boolean) => ({
  key: (c: Chat) =>
    (pin ? (c.pinned ? "1" : "0") : "") +
    (c.archived ? "0" : "1") +
    (c.conversationTimestamp
      ? c.conversationTimestamp.toString(16).padStart(8, "0")
      : "") +
    c.id,
  compare: (k1: string, k2: string) => k2.localeCompare(k1),
});

export const waMessageID = (m: WAMessage) => m.key.id || "";

export const waLabelAssociationKey: Comparable<LabelAssociation, string> = {
  key: (la: LabelAssociation) =>
    la.type === LabelAssociationType.Chat
      ? la.chatId + la.labelId
      : la.chatId + la.messageId + la.labelId,
  compare: (k1: string, k2: string) => k2.localeCompare(k1),
};
export type CronJobConfig = {
  /**
   * Create crontab expressions from https://crontab.guru/
   */
  cronTime: string | Date;
  /**
   * Timezone of the cron job
   * @default "Asia/Calcutta"
   */
  timeZone?: string;
  onComplete?: Function;
};

export type BaileyesMongoStoreConfig = {
  chatKey?: Comparable<Chat, string>;
  labelAssociationKey?: Comparable<LabelAssociation, string>;
  logger?: Logger;
  /**
   * You can set it to not save chats without messages.
   *
   * Use this filter to identify unsaved chat types in your current databse.
   *
   *     	{ $and: [
   * 					{ 'messages.message.messageStubType': { $exists: true } },
   * 					{ 'messages.message.message': { $exists: true } }
   * 				]
   * 		}
   *
   */
  filterChats?: boolean;
  /**
   * Cron job to delete status message. Set to false to disable
   *
   * Deletes all status messages older than 24 hours on At 00:00 (default)
   * @default config {cronTime: "0 0 * * *", timeZone: "Asia/Calcutta"}
   */
  autoDeleteStatusMessage: boolean | CronJobConfig;
  db: Db;
};

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID);

const predefinedLabels = Object.freeze<Record<string, Label>>({
  "0": {
    id: "0",
    name: "New customer",
    predefinedId: "0",
    color: 0,
    deleted: false,
  },
  "1": {
    id: "1",
    name: "New order",
    predefinedId: "1",
    color: 1,
    deleted: false,
  },
  "2": {
    id: "2",
    name: "Pending payment",
    predefinedId: "2",
    color: 2,
    deleted: false,
  },
  "3": {
    id: "3",
    name: "Paid",
    predefinedId: "3",
    color: 3,
    deleted: false,
  },
  "4": {
    id: "4",
    name: "Order completed",
    predefinedId: "4",
    color: 4,
    deleted: false,
  },
});

export default ({
  logger: _logger,
  db,
  filterChats,
  autoDeleteStatusMessage,
}: BaileyesMongoStoreConfig) => {
  const isOlderThan24Hours = (timestamp: number): boolean => {
    const currentTime = moment(new Date()).tz("Asia/Kolkata");
    const providedTime = moment(timestamp * 1000).tz("Asia/Kolkata");

    const hoursDifference = currentTime.diff(providedTime, "hours");
    return hoursDifference > 24;
  };

  if (autoDeleteStatusMessage) {
    if (typeof autoDeleteStatusMessage === "boolean") {
      autoDeleteStatusMessage = {
        cronTime: "0 0 * * *",
        timeZone: "Asia/Calcutta",
      };
    }

    new CronJob(
      autoDeleteStatusMessage.cronTime, // cronTime
      async () => {
        const statusMesasges = await chats.findOne(
          { id: "status@broadcast" },
          { projection: { _id: 0 } }
        );

        if (statusMesasges) {
          statusMesasges.messages = statusMesasges?.messages
            ?.filter((m: proto.IHistorySyncMsg) => {
              const messageTimestamp =
                typeof m?.message?.messageTimestamp === "number"
                  ? m.message.messageTimestamp
                  : (m?.message?.messageTimestamp?.low as number);
              return !isOlderThan24Hours(messageTimestamp) ? m : null;
            })
            .filter(
              (m: proto.IHistorySyncMsg | null) => m !== null
            ) as proto.IHistorySyncMsg[];

		  await chats.replaceOne(
		    { id: "status@broadcast" },
		    { ...statusMesasges },
		    { upsert: true }
		  )
        }
      },
      () => {
        logger?.debug("Purged status messages older than 24 hours");
      },
      true, // start
      autoDeleteStatusMessage?.timeZone
    );
  }

  const logger =
    _logger ||
    DEFAULT_CONNECTION_CONFIG.logger.child({ stream: "mongo-store" });
  const chats = db.collection<Chat>("chats");
  const messages: { [_: string]: ReturnType<typeof makeMessagesDictionary> } =
    {};
  const contacts = db.collection<Contact>("contacts");
  const groupMetadata: { [_: string]: GroupMetadata } = {};
  const presences: { [id: string]: { [participant: string]: PresenceData } } =
    {};
  const state: ConnectionState = { connection: "close" };
  const labels = new ObjectRepository<Label>(predefinedLabels);
  const labelAssociations =
    db.collection<LabelAssociation>("labelAssociations");

  const assertMessageList = (jid: string) => {
    if (!messages[jid]) {
      messages[jid] = makeMessagesDictionary();
    }

    return messages[jid];
  };

  const labelsUpsert = (newLabels: Label[]) => {
    for (const label of newLabels) {
      labels.upsertById(label.id, label);
    }
  };

  const bind = (ev: BaileysEventEmitter) => {
    ev.on("connection.update", (update) => {
      Object.assign(state, update);
    });

    ev.on(
      "messaging-history.set",
      async ({
        chats: newChats,
        contacts: newContacts,
        messages: newMessages,
      }) => {
        if (filterChats) {
          newChats = newChats
            .map((chat) => {
              if (
                chat.messages?.some(
                  (m) => !m.message?.message && m.message?.messageStubType
                )
              ) {
                return undefined;
              }

              return chat;
            })
            .filter(Boolean) as Chat[];
        }

        if (newChats.length) {
          const chatsAdded = await chats.bulkWrite(
            newChats.map((chat) => {
              return {
                insertOne: {
                  document: chat,
                },
              };
            })
          );

          logger.debug(
            { chatsAdded: chatsAdded.insertedCount },
            "synced chats"
          );
        } else {
          logger.debug("no chats added");
        }

        const oldContacts = await contacts.bulkWrite(
          newContacts.map((contact) => {
            return {
              insertOne: {
                document: contact,
              },
            };
          })
        );
        logger.debug(
          { insertedContacts: oldContacts.insertedCount },
          "synced contacts"
        );

        if (!oldContacts.insertedCount) {
          throw new Error("no contacts added");
        }

        for (const msg of newMessages) {
          const jid = msg.key.remoteJid!;
          const list = assertMessageList(jid);
          list.upsert(msg, "prepend");

          const chat = await chats.findOne(
            { id: jid },
            { projection: { _id: 0 } }
          );

          if (chat) {
            chat.messages?.push({ message: msg }) ||
              (chat.messages = [{ message: msg }]);
            await chats.findOneAndUpdate(
              { id: jid },
              { $set: chat },
              { upsert: true }
            );
          } else {
            logger.debug({ jid }, "chat not found");
          }
        }

        logger.debug({ messages: newMessages.length }, "synced messages");
      }
    );

    ev.on("contacts.upsert", async (Contacts) => {
      for (const contact of Contacts) {
        await contacts.updateOne(
          { id: contact.id },
          { $set: contact },
          { upsert: true }
        );
      }

      logger?.debug({ contactsUpserted: Contacts.length }, "contacts upserted");
    });

    ev.on("contacts.update", async (updates) => {
      for (const update of updates) {
        const contact: Partial<Contact> | null = await contacts.findOne(
          { id: update.id },
          { projection: { _id: 0 } }
        );

        if (contact) {
          Object.assign(contact, update);
          await contacts.updateOne(
            { id: update.id },
            { $set: contact },
            { upsert: true }
          );
        } else {
          logger.debug("got update for non-existent contact");
        }
      }
    });

    ev.on("chats.upsert", async (newChats) => {
      await chats.bulkWrite(
        newChats.map((chat) => {
          return {
            updateOne: {
              filter: { id: chat.id },
              update: { $set: chat },
              upsert: true,
            },
          };
        })
      );
    });

    ev.on("chats.update", async (updates) => {
      // try {
      for (const update of updates) {
        const chat = await chats.findOneAndUpdate(
          { id: update.id },
          {
            $set: update,
          },
          { upsert: true }
        );

        if (!chat) {
          logger.debug("got update for non-existant chat");
        }
      }
    });

    ev.on("labels.edit", (label: Label) => {
      if (label.deleted) {
        return labels.deleteById(label.id);
      }

      // WhatsApp can store only up to 20 labels
      if (labels.count() < 20) {
        return labels.upsertById(label.id, label);
      }

      logger.error("Labels count exceed");
    });

    ev.on("labels.association", async ({ type, association }) => {
      switch (type) {
        case "add":
          await labelAssociations.updateOne(
            { id: association?.chatId || association?.labelId },
            { $set: association },
            { upsert: true }
          );
          break;
        case "remove":
          await labelAssociations.deleteOne({
            id: association?.chatId || association?.labelId,
          });
          break;
        default:
          logger.error(`unknown operation type [${type}]`);
      }
    });

    ev.on("presence.update", ({ id, presences: update }) => {
      presences[id] = presences[id] || {};
      Object.assign(presences[id], update);
    });

    ev.on("chats.delete", async (deletions) => {
      for (const item of deletions) {
        await chats.deleteOne({ id: item });
      }
    });

    ev.on("messages.upsert", async ({ messages: newMessages, type }) => {
      // try {
      switch (type) {
        case "append":
        case "notify":
          for (const msg of newMessages) {
            const jid = jidNormalizedUser(msg.key.remoteJid!);
            const list = assertMessageList(jid);
            list.upsert(msg, "append");

            const chat = await chats.findOne({ id: jid });
            if (type === "notify") {
              if (!chat) {
                ev.emit("chats.upsert", [
                  {
                    id: jid,
                    conversationTimestamp: toNumber(msg.messageTimestamp),
                    unreadCount: 1,
                  },
                ]);
              } else {
                chat.messages
                  ? chat.messages.push({ message: msg })
                  : (chat.messages = [{ message: msg }]);
                await chats.updateOne(
                  { id: jid },
                  { $set: chat },
                  { upsert: true }
                );
              }
            }
          }

          break;
      }
    });

    ev.on("messages.update", (updates) => {
      for (const { update, key } of updates) {
        const list = assertMessageList(jidNormalizedUser(key.remoteJid!));
        if (update?.status) {
          const listStatus = list.get(key.id!)?.status;
          if (listStatus && update?.status <= listStatus) {
            logger.debug(
              { update, storedStatus: listStatus },
              "status stored newer then update"
            );
            delete update.status;
            logger.debug({ update }, "new update object");
          }
        }

        const result = list.updateAssign(key.id!, update);
        if (!result) {
          logger.debug("got update for non-existent message");
        }
      }
    });

    ev.on("messages.delete", (item) => {
      if ("all" in item) {
        const list = messages[item.jid];
        list?.clear();
      } else {
        const jid = item.keys[0].remoteJid!;
        const list = messages[jid];
        if (list) {
          const idSet = new Set(item.keys.map((k) => k.id));
          list.filter((m) => !idSet.has(m.key.id));
        }
      }
    });

    ev.on("groups.update", (updates) => {
      for (const update of updates) {
        const id = update.id!;
        if (groupMetadata[id]) {
          Object.assign(groupMetadata[id], update);
        } else {
          logger.debug(
            { update },
            "got update for non-existant group metadata"
          );
        }
      }
    });

    ev.on("group-participants.update", ({ id, participants, action }) => {
      const metadata = groupMetadata[id];
      if (metadata) {
        switch (action) {
          case "add":
            metadata.participants.push(
              ...participants.map((id) => ({
                id,
                isAdmin: false,
                isSuperAdmin: false,
              }))
            );
            break;
          case "demote":
          case "promote":
            for (const participant of metadata.participants) {
              if (participants.includes(participant.id)) {
                participant.isAdmin = action === "promote";
              }
            }

            break;
          case "remove":
            metadata.participants = metadata.participants.filter(
              (p) => !participants.includes(p.id)
            );
            break;
        }
      }
    });

    ev.on("message-receipt.update", (updates) => {
      for (const { key, receipt } of updates) {
        const obj = messages[key.remoteJid!];
        const msg = obj?.get(key.id!);
        if (msg) {
          updateMessageWithReceipt(msg, receipt);
        }
      }
    });

    ev.on("messages.reaction", (reactions) => {
      for (const { key, reaction } of reactions) {
        const obj = messages[key.remoteJid!];
        const msg = obj?.get(key.id!);
        if (msg) {
          updateMessageWithReaction(msg, reaction);
        }
      }
    });
  };

  const toJSON = () => ({
    chats,
    contacts,
    messages,
    labels,
    labelAssociations,
  });

  // TODO: replace upsert logic by corresponding mongodb collection methods
  const fromJSON = async (json: {
    chats: Chat[];
    contacts: { [id: string]: Contact };
    messages: { [id: string]: WAMessage[] };
    labels: { [labelId: string]: Label };
    labelAssociations: LabelAssociation[];
  }) => {
    await chats.updateMany({}, { $set: { ...json.chats } }, { upsert: true });
    await labelAssociations.updateMany(
      {},
      { $set: { ...(json.labelAssociations || []) } },
      { upsert: true }
    );

    const contactsCollection = db.collection<Contact>("contacts");
    await contactsCollection.updateMany(
      {},
      { $set: { ...Object.values(json.contacts) } },
      { upsert: true }
    );

    // contactsUpsert(Object.values(json.contacts))
    labelsUpsert(Object.values(json.labels || {}));
    for (const jid in json.messages) {
      const list = assertMessageList(jid);
      for (const msg of json.messages[jid]) {
        list.upsert(proto.WebMessageInfo.fromObject(msg), "append");
      }
    }
  };

  /**
   * Retrieves a chat object by its ID.
   *
   * @param {string} jid - The ID of the chat.
   * @return {Promise<Chat|null>} A promise that resolves to the chat object if found, or null if not found.
   */
  const getChatById = async (jid: string): Promise<Chat | null> => {
    return await chats.findOne({ id: jid }, { projection: { _id: 0 } });
  };

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
      const list = assertMessageList(jid);
      const mode = !cursor || "before" in cursor ? "before" : "after";
      const cursorKey = !!cursor
        ? "before" in cursor
          ? cursor.before
          : cursor.after
        : undefined;
      const cursorValue = cursorKey ? list.get(cursorKey.id!) : undefined;

      let messages: WAMessage[];
      if (list && mode === "before" && (!cursorKey || cursorValue)) {
        if (cursorValue) {
          const msgIdx = list.array.findIndex(
            (m) => m.key.id === cursorKey?.id
          );
          messages = list.array.slice(0, msgIdx);
        } else {
          messages = list.array;
        }

        const diff = count - messages.length;
        if (diff < 0) {
          messages = messages.slice(-count); // get the last X messages
        }
      } else {
        messages = [];
      }

      return messages;
    },
    /**
     * Get all available labels for profile
     *
     * Keep in mind that the list is formed from predefined tags and tags
     * that were "caught" during their editing.
     */
    getLabels: () => {
      return labels;
    },

    /**
     * Get labels for chat
     *
     * @returns Label IDs
     **/
    getChatLabels: (chatId: string) => {
      return labelAssociations.findOne(
        (la: { chatId: string }) => la.chatId === chatId
      );
    },

    /**
     * Get labels for message
     *
     * @returns Label IDs
     **/
    getMessageLabels: async (messageId: string) => {
      const associations = labelAssociations.find(
        (la: MessageLabelAssociation) => la.messageId === messageId
      );

      return associations?.map(({ labelId }) => labelId);
    },
    loadMessage: async (jid: string, id: string) => {
      if (messages[jid]) {
        return messages[jid].get(id);
      }

      const chat = await chats.findOne({ id: jid }, { projection: { _id: 0 } });
      for (const m of chat?.messages ?? []) {
        if (m?.message?.key.id === id) {
          return m.message;
        }
      }
    },
    mostRecentMessage: async (jid: string) => {
      const message: WAMessage | undefined =
        messages[jid]?.array.slice(-1)[0] ||
        (
          await chats.findOne({ id: jid }, { projection: { _id: 0 } })
        )?.messages?.slice(-1)[0].message ||
        undefined;
      return message;
    },
    fetchImageUrl: async (jid: string, sock: WASocket | undefined) => {
      const contact = await contacts.findOne(
        { id: jid },
        { projection: { _id: 0 } }
      );
      if (!contact) {
        return sock?.profilePictureUrl(jid);
      }

      if (typeof contact.imgUrl === "undefined") {
        contact.imgUrl = await sock?.profilePictureUrl(jid);
        await contacts.updateOne(
          { id: jid },
          { $set: contact },
          { upsert: true }
        );
      }

      return contact.imgUrl;
    },
    getContactInfo: async (
      jid: string,
      socket: WASocket
    ): Promise<Partial<Contact> | null> => {
      const contact: Partial<Contact> | null = await contacts.findOne(
        { id: jid },
        { projection: { _id: 0 } }
      );

      if (!contact) {
        return {
          id: jid,
          imgUrl: await socket?.profilePictureUrl(jid),
        };
      }

      // fetch image if required
      if (
        typeof contact.imgUrl === "undefined" ||
        contact.imgUrl === "changed"
      ) {
        contact.imgUrl = await socket?.profilePictureUrl(contact.id!, "image");
        await contacts.updateOne(
          { id: jid },
          { $set: { ...contact } },
          { upsert: true }
        );
      }

      return contact;
    },
    fetchGroupMetadata: async (jid: string, sock: WASocket | undefined) => {
      if (!groupMetadata[jid]) {
        const metadata = await sock?.groupMetadata(jid);
        if (metadata) {
          groupMetadata[jid] = metadata;
        }
      }

      return groupMetadata[jid];
    },

    fetchMessageReceipts: async ({ remoteJid, id }: WAMessageKey) => {
      const list = messages[remoteJid!];
      const msg = list?.get(id!);
      return msg?.userReceipt;
    },
    getChatById,
    toJSON,
    fromJSON,
  };
};
