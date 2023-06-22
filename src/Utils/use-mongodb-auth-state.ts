import WAProto from "../../WAProto";
import { AuthenticationCreds, AuthenticationState } from "../Types/Auth";
import { initAuthCreds } from "./auth-utils";
import { BufferJSON} from "./generics"; 
import type { Collection, Document, UpdateResult } from "mongodb";

export const useMongoDBAuthState = async (collection: Collection<Document>): Promise<{ state: { creds: AuthenticationCreds, keys: { get: (type: string, ids: string[]) => Promise<Object> , set: (data: Object) => Promise<void> } }, saveCreds: () => Promise<Document | UpdateResult<Document>> }> => {

    const writeData = (data: any, id: string) => {
        return collection.replaceOne({id}, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), {upsert: true});
    };
    const readData = async (id: string) => {
        try {
            const data = JSON.stringify(await collection.findOne({id}));
            return JSON.parse(data, BufferJSON.reviver);
        }
        catch (error) {
            return null;
        }
    };
    const removeData = async (id: string) => {
        try {
            await collection.deleteOne({id});
        }
        catch (_a) {
        }
    };
    const creds: AuthenticationCreds = await readData('creds') || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type: string, ids: string[]) => {
                    const data: Object = {};
                    await Promise.all(ids.map(async (id: string | number) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key') {
                            value =(WAProto.proto as any).AppStateSyncKeyData.fromObject(data);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data: { [x: string]: { [x: string]: any; }; }) => {
                    const tasks: any[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            let _value = data[category][id];
                            let _id = `${category}-${id}`;
                            tasks.push(_value ? writeData(_value, _id) : removeData(id));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
};