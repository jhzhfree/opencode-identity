// Studio and generated plugins load the one canonical SDK implementation.
import {sdk} from '../sdk.mjs';
const client = (await sdk()).akbClient;
export const {TOOLS,validateKnowledgeBaseId,publicPathPrefixOf,apiUrl,loadAkbConfig,serviceCredential,invocationSignal,requestJson,mcp,initializeMcp,verifyAgent,invocationScope,invokeAkb} = client;
