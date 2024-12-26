import { pineconeMiddleware } from './rag-middleware';
import { experimental_wrapLanguageModel as wrapLanguageModel, streamText,smoothStream } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY
});



const wrappedModel = wrapLanguageModel({
  model: google('gemini-2.0-flash-exp'),
  middleware: pineconeMiddleware,
});

export async function POST(req) {
  try {
    const { messages } = await req.json();
    
    const result = streamText({
      model: wrappedModel,
      messages,
     
      experimental_transform: smoothStream({
        delayInMs: 20, 
      }),
      
    });
    
    return result.toDataStreamResponse();
  } catch (error) {
    console.error('Error in route handler:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}