import { DLClient } from "./dl-client.js";

const dlClients = new Map<string, DLClient>();

export const getDLClient = (accountId:string)=>{
    return dlClients.get(accountId) ?? null;
}

export const setDLClient = (accountId:string, client:DLClient)=>{
    dlClients.set(accountId, client);
}

export const removeDLClient = (accountId:string)=>{
    dlClients.delete(accountId);
}