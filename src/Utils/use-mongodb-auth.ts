import type { Collection, Condition, Document, ObjectId } from "mongodb";
import type { Logger } from "pino";
import { proto } from "../../WAProto";
import {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from "../Types";
import { initAuthCreds } from "./auth-utils";
import { BufferJSON } from "./generics";

export const useMongoDBAuthState = async (
  collection: Collection<{ id: string } & any>,
  logger?: Logger
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const writeData = async (id: string, data: AuthenticationCreds) => {
    logger?.debug({ id }, "writing data");

    await collection.replaceOne(
      { id },
      { id, ...JSON.parse(JSON.stringify(data, BufferJSON.replacer)) }, // complete replace instead of partial
      { upsert: true }
    );
  };

  const readData = async (id: string): Promise<any | null> => {
    logger?.debug({ id }, "reading data");

    const data = await collection.findOne(
      { id },
      { projection: { _id: 0, id: 0 } }
    );

    return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
  };

  const removeData = async (id: string) => {
    logger?.debug({ id }, "removing data");
    await collection.deleteOne({ id });
  };

  const creds: AuthenticationCreds =
    (await readData("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids: string[]) => {
          logger?.debug({ ids, type }, "getting data");
          const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          logger?.debug({ data }, "setting data");
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }

          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      logger?.debug({ creds }, "saving creds");
      await writeData("creds", creds);
    },
  };
};
