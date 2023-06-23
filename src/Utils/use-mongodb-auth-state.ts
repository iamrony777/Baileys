import { proto } from "../../WAProto";
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "../Types";
import { initAuthCreds } from "./auth-utils";
import { BufferJSON } from "./generics";
import type { Collection, Condition, Document, ObjectId } from "mongodb";
import type { Logger } from 'pino'

export const useMongoDBAuthState = async (collection: Collection<Document>, logger?: Logger): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => {

    const writeData = async (data: any, id: string) => {

        logger?.debug({ id, data }, 'writing data')

        await collection.replaceOne({ _id: id as unknown as Condition<ObjectId> }, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), { upsert: true });
    };
    const readData = async (id: string) => {

        logger?.debug({ id }, 'reading data')

        try {
            const data = JSON.stringify(await collection.findOne({ _id: id as unknown as Condition<ObjectId> }));

            logger?.debug('data', data)
            return JSON.parse(data, BufferJSON.reviver);
        }
        catch (error) {
            return null;
        }
    };
    const removeData = async (id: string) => {
        logger?.debug({ id }, 'removing data')

        try {
            await collection.deleteOne({ _id: id as unknown as Condition<ObjectId> });
        }
        catch (_a) {
        }
    };
    const creds: AuthenticationCreds = await readData('creds') || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids: string[]) => {

                    logger?.debug({ ids, type }, 'getting data')
                    const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {

                    logger?.debug({ data }, 'setting data');
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            let value = data[category][id];
                            let collection = `${category}-${id}`;
                            tasks.push(value ? writeData(value, collection) : removeData(collection));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            logger?.debug({ creds }, 'saving creds');
            writeData(creds, 'creds');
        }
    };
};