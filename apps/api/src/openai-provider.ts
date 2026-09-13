export const DEFAULT_OPENAI_TEXT_MODEL='gpt-5.6-luna';
export const DEFAULT_OPENAI_IMAGE_MODEL='gpt-image-2.5-flare';

export class OpenAIProviderError extends Error {
  constructor(message:string,public readonly status=503,public readonly retryable=false){super(message);this.name='OpenAIProviderError';}
}

export function openAIConfig(){
  const key=(process.env.OPENAI_API_KEY||'').trim();
  return {
    key,
    configured:key.startsWith('sk-')&&key.length>=20,
    textModel:(process.env.OPENAI_TEXT_MODEL||DEFAULT_OPENAI_TEXT_MODEL).trim(),
    imageModel:(process.env.OPENAI_IMAGE_MODEL||DEFAULT_OPENAI_IMAGE_MODEL).trim()
  };
}

export async function openAIRequest(path:string,body:unknown,signal?:AbortSignal,timeoutMs=120000){
  const {key,configured}=openAIConfig();
  if(!configured)throw new OpenAIProviderError('OpenAI не підключено. Перевір OPENAI_API_KEY у Render.',503,false);
  const controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(`https://api.openai.com/v1/${path}`,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){
      await response.body?.cancel();
      const retryable=[408,409,429,500,502,503,504].includes(response.status);
      const message=response.status===401||response.status===403
        ?'OpenAI не прийняв API-ключ або доступ до моделі.'
        :response.status===429?'OpenAI тимчасово досяг ліміту запитів.':'OpenAI не підтвердив генерацію.';
      throw new OpenAIProviderError(message,response.status,retryable);
    }
    return await response.json() as unknown;
  }catch(error){
    if(error instanceof OpenAIProviderError)throw error;
    if(signal?.aborted)throw new OpenAIProviderError('Генерацію перервано зупинкою сервера.',503,false);
    throw new OpenAIProviderError('OpenAI тимчасово не відповідає.',503,true);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
