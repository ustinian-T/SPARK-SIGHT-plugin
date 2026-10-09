// 可插拔 Embedding 接口：记忆模块不硬依赖外部向量 API。
// 默认提供 NullEmbeddingProvider（不可用、返回空数组），
// 运行时可通过 setEmbeddingProvider 注入真实实现（如 OpenAI / 本地模型）。
//
// 接口约定：
//   class XxxEmbeddingProvider {
//     get available() { return boolean }
//     async embed(texts: string[]): Promise<number[][]>
//   }

/** 默认空实现：不可用，embed 返回空数组 */
export class NullEmbeddingProvider {
  get available() { return false }
  /** @param {string[]} texts */
  async embed(texts) {
    // 与输入等长的空向量列表（表示无 embedding 结果）
    return texts.map(() => [])
  }
}

let _provider = new NullEmbeddingProvider()

/**
 * 运行时注入 embedding provider。
 * @param {{available:boolean, embed:(texts:string[])=>Promise<number[][]>}} provider
 */
export function setEmbeddingProvider(provider) {
  if (!provider || typeof provider.embed !== 'function') {
    throw new TypeError('embedding provider 必须实现 embed(texts) 方法')
  }
  _provider = provider
}

/** 获取当前 provider（默认 NullEmbeddingProvider） */
export function getEmbeddingProvider() {
  return _provider
}
