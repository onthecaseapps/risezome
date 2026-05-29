import { buildClassifierSystem, CLASSIFIER_SYSTEM_PROMPT } from '../src/router/prompt.js';
const blocks = buildClassifierSystem();
const text = blocks.map(b => b.text).join('');
console.log('blocks:', blocks.length);
console.log('total chars:', text.length);
console.log('approx tokens (chars/4):', Math.round(text.length/4));
console.log('full prompt chars (system + additional):', CLASSIFIER_SYSTEM_PROMPT.length);
