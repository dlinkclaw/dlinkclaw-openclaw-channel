import { DLClient } from "./dl-client.js";

const dlClients = new Map<string, DLClient>();

export const getDLClient = (accountId:string)=>{
    return dlClients.get(accountId) ?? null;
}

export const setDLClient = (accountId:string, client:DLClient)=>{
    dlClients.set(accountId, client);
}

// 2026-10-26 人设注入用：取当前任一已初始化的 dlink 客户端（单账号场景即默认账号）
export const getAnyDLClient = (): DLClient | null => {
    for (const client of dlClients.values()) {
        return client;
    }
    return null;
}

export const removeDLClient = (accountId:string)=>{
    dlClients.delete(accountId);
}