export function sourceDocument(value: unknown): {language:string;content:string} {
  const input = value as {engine?: string;source?: string} | null
  const languages: Record<string,string> = {python:'python',r:'r',matlab:'matlab',node:'javascript'}
  if (!input || typeof input.engine !== 'string' || !Object.hasOwn(languages, input.engine) || typeof input.source !== 'string' || input.source.length > 2000000) throw new Error('Invalid generated source')
  return {language:languages[input.engine],content:input.source}
}
