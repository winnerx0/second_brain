import { config } from './config';
import { ChatOpenAI } from '@langchain/openai';

export const model = new ChatOpenAI({
  apiKey: config.OPENAI_API_KEY,
  model: 'gpt-5-nano',
  temperature: 1,
  maxRetries: 3,
});
