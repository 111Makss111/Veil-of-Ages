import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIImageGenerator } from './factory-ai.js';
import { buildOpenAISongRequest } from './factory-song.js';
import { DEFAULT_OPENAI_IMAGE_MODEL, DEFAULT_OPENAI_TEXT_MODEL, openAIConfig, openAIRequest } from './openai-provider.js';

const originalFetch=globalThis.fetch,originalKey=process.env.OPENAI_API_KEY,originalTextModel=process.env.OPENAI_TEXT_MODEL,originalImageModel=process.env.OPENAI_IMAGE_MODEL;
const restore=(name:string,value:string|undefined)=>{if(value===undefined)delete process.env[name];else process.env[name]=value;};
afterEach(()=>{globalThis.fetch=originalFetch;restore('OPENAI_API_KEY',originalKey);restore('OPENAI_TEXT_MODEL',originalTextModel);restore('OPENAI_IMAGE_MODEL',originalImageModel);});

test('OpenAI configuration uses the selected economical models',()=>{
  process.env.OPENAI_API_KEY='sk-test-'+('x'.repeat(40));
  delete process.env.OPENAI_TEXT_MODEL;delete process.env.OPENAI_IMAGE_MODEL;
  assert.equal(openAIConfig().textModel,DEFAULT_OPENAI_TEXT_MODEL);
  assert.equal(openAIConfig().imageModel,DEFAULT_OPENAI_IMAGE_MODEL);
});

test('OpenAI request keeps the key in the authorization header',async()=>{
  process.env.OPENAI_API_KEY='sk-test-'+('x'.repeat(40));let seen:RequestInit|undefined;
  globalThis.fetch=(async(_url,init)=>{seen=init;return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  await openAIRequest('responses',{model:DEFAULT_OPENAI_TEXT_MODEL,input:'test'});
  assert.equal((seen?.headers as Record<string,string>).Authorization,`Bearer ${process.env.OPENAI_API_KEY}`);
  assert.doesNotMatch(JSON.stringify(seen?.body),/sk-test/);
});

test('song generator asks Luna for a strict structured package',()=>{
  const request=buildOpenAISongRequest('Write a new song',DEFAULT_OPENAI_TEXT_MODEL);
  assert.equal(request.model,DEFAULT_OPENAI_TEXT_MODEL);
  assert.equal(request.text.format.type,'json_schema');
  assert.equal(request.text.format.strict,true);
  assert.deepEqual(request.text.format.schema.required,['title','concept','lyrics','sunoPrompt','artworkPrompt']);
});

test('OpenAI image generator requests Flare and decodes the returned JPEG',async()=>{
  process.env.OPENAI_API_KEY='sk-test-'+('x'.repeat(40));let body:Record<string,unknown>={};
  const jpeg=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(20)]);
  globalThis.fetch=(async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({data:[{b64_json:jpeg.toString('base64')}]}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  const generator=createOpenAIImageGenerator();assert.ok(generator);
  const result=await generator!('Nordic scene',17);
  assert.equal(body.model,DEFAULT_OPENAI_IMAGE_MODEL);assert.equal(body.size,'1536x1024');assert.equal(result.type,'image/jpeg');assert.deepEqual(result.data,jpeg);
});
