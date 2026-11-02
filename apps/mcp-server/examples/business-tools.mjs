/**
 * 业务工具示例 —— 深层模块如何拿到调用方身份。
 *
 * 启动：
 *   node bin/serve.mjs --registry <registry.json> --tools examples/business-tools.mjs
 *
 * run() 完全不使用第二个参数 context：身份来自 AsyncLocalStorage
 * （../lib/context.mjs）。无论调用链多深、中间隔了多少个 await，
 * currentIdentity() 拿到的都是服务端验签后冻结的那一份
 * （uuid / agentName / kid / sessionId / invocationId / verified:true），
 * 伪造不了，也改不动；在请求链之外调用会直接抛错而不是返回未验证的值。
 */
import { currentIdentity } from '../lib/context.mjs';

export default {
  whoami_deep: {
    description: 'Return the verified caller identity read from the request context (deep layer demo)',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(args) {
      if (Object.keys(args).length) {
        throw new Error('whoami_deep takes no arguments; identity comes from the request context');
      }
      // 模拟一次真实的异步 IO：身份在 await 之后依然可用。
      await new Promise(resolve => setImmediate(resolve));
      const { uuid, agentName, kid, sessionId, invocationId } = currentIdentity();
      return { deep: true, uuid, agentName, kid, sessionId, invocationId };
    },
  },
};
