import { ChatOpenRouter } from '@langchain/openrouter';
import { config } from './config.js';
import { ChatOpenAI } from '@langchain/openai';
import { ChatXAI } from '@langchain/xai';

// export const model = new ChatOpenAI({
//   apiKey: config.OPENAI_API_KEY,
//   model: 'gpt-5-nano',
//   temperature: 1,
//   maxRetries: 3,
// });

// export const model = new ChatOpenRouter({
//   apiKey: config.OPENROUTER_API_KEY,
//   model: 'deepseek/deepseek-v3.2',
//   temperature: 1,
//   maxRetries: 3,
// });

export const model = new ChatXAI({
    apiKey: config.XAI_API_KEY,
    model: "grok-4-1-fast-reasoning", 
    temperature: 0.8,
    maxTokens: 5000,
    maxRetries: 3,
})