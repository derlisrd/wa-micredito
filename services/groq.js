import dotenv from 'dotenv';
dotenv.config(); 

import { Groq } from 'groq-sdk';

const groq = new Groq();


export const groqService = {
    name: 'Groq',
     async chat(messages){
        const chatCompletion = await groq.chat.completions.create({
        messages,
        model: "moonshotai/kimi-k2-instruct-0905",
        temperature: 0.6,
        max_completion_tokens: 4096,
        top_p: 1,
        stream: true,
        stop: null
        });
        
        

        return (async function * (){
            for await (const chunk of chatCompletion) {
         yield chunk.choices[0]?.delta?.content || ''
        }
        })();   
    }
}


/* "messages": [
            {
            "role": "user",
            "content": "Como se soluciona fibonachi en javascript?"
            }
        ], */

