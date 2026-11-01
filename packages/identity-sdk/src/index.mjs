/**
 * @opencode-identity/sdk — public entry point.
 *
 * One dependency-free module that owns every piece of agent identity crypto:
 *
 *   keys      generate an RSA-3072 pair, derive the key id, import/export
 *   uuid      generate and validate the agent trust UUID
 *   identity  sign `{agentName, uuid}` with the private key, verify with the public key
 *             (`verifyWithPublicKey` is the standalone verifier that needs no private key)
 *   proof     sign/verify a single HTTP request (body + method + audience bound)
 *   registry  build and validate the public-key registry, verify attestations
 *   client    a signed JSON-RPC client used by CLIs and the Studio panel
 *
 * Consumers: the plugin generator tool (generation side) and the MCP server
 * (verification side). Both import from here, so there is exactly one
 * implementation of the signing rules.
 */
export * from './errors.mjs';
export * from './canonical.mjs';
export * from './uuid.mjs';
export * from './keys.mjs';
export * from './identity.mjs';
export * from './proof.mjs';
export * from './registry.mjs';
export * from './client.mjs';
export * from './agent.mjs';

export const SDK_NAME = '@opencode-identity/sdk';
export const SDK_VERSION = '1.1.0';

/**
 * Machine-readable surface description, used by the Studio UI and `sdk describe`.
 * Keep in sync with the exports above.
 */
export function describe() {
  return {
    name: SDK_NAME,
    version: SDK_VERSION,
    runtime: `node ${process.versions.node}`,
    modules: [
      { id: 'keys', purpose: '生成 RSA-3072 密钥对、推导 kid、导入导出', methods: ['generateKeyPair', 'publicJwkOf', 'keyId', 'importPrivateKey', 'importPublicKey', 'exportPublicPem', 'assertKeyStrength'] },
      { id: 'uuid', purpose: '生成与校验 Agent 信任 UUID', methods: ['generateUuid', 'isUuid', 'assertUuid'] },
      { id: 'identity', purpose: '用私钥对 Agent 名称 + UUID 签名，用公钥验签', methods: ['buildIdentityClaim', 'signIdentity', 'verifyIdentity', 'verifyWithPublicKey', 'normalizePublicKey', 'inspectAttestation', 'verifyEnrollment', 'assertAgentName'] },
      { id: 'proof', purpose: '单次请求签名（绑定 body/方法/受众）与重放防护', methods: ['createProof', 'verifyProof', 'createReplayStore', 'registryResolver', 'assertLocalEndpoint', 'bodyHash'] },
      { id: 'registry', purpose: '构建并校验公钥注册表，校验身份证明', methods: ['buildEnrollment', 'validateRegistry', 'attestationReport'] },
      { id: 'client', purpose: '带签名的 JSON-RPC 客户端（CLI / Studio / 部署脚本共用）', methods: ['validateTerminalConfig', 'agentByName', 'readPrivateKeyFile', 'createSignedClient', 'verifyAgent'] },
      { id: 'agent', purpose: '一步生成「密钥对 + UUID + 身份证明」', methods: ['createAgentIdentity'] },
    ],
  };
}
