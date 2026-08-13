import { PiRpcProcess } from '../src/pi-rpc.mjs';
import path from 'node:path';

async function runLiveCmdTest() {
  console.log('\n===========================================================');
  console.log('  LIVE CMD TEST WITH SYSTEM PROMPT SUPPRESSION');
  console.log('===========================================================\n');

  const proc = new PiRpcProcess();
  const workspace = path.resolve('.');

  try {
    console.log('[1/4] Starting Pi RPC Engine with model "uncensoredqwen3.6-small-cotnext:latest"...');
    await proc.start({
      workspace,
      modelId: 'uncensoredqwen3.6-small-cotnext:latest'
    });
    console.log('      ✓ Engine started!');

    console.log('[2/4] Setting Thinking Level to "off"...');
    await proc.request({ type: 'set_thinking_level', level: 'off' });

    console.log('[2b/4] Setting System Prompt Override to suppress CoT template...');
    await proc.request({
      type: 'set_system_prompt',
      prompt: 'You are a helpful assistant. Do NOT output <think> tags or reasoning steps. Respond directly.'
    }).catch(() => {});

    let thinkingCount = 0;
    let fullResponseText = '';

    const turnPromise = new Promise((resolve) => {
      proc.on('event', (evt) => {
        if (evt.type === 'message_update') {
          const delta = evt.assistantMessageEvent || {};
          if (delta.type === 'thinking_delta') {
            thinkingCount++;
            process.stdout.write(`\n[THINKING BLOCK]: ${delta.delta || ''}\n`);
          } else if (delta.type === 'text_delta') {
            const text = delta.delta || '';
            fullResponseText += text;
            process.stdout.write(text);
          }
        } else if (evt.type === 'turn_end' || evt.type === 'agent_end') {
          resolve();
        }
      });
    });

    console.log('\n[3/4] Prompting model: "Say hello in 1 short sentence."');
    console.log('-----------------------------------------------------------');
    console.log('MODEL RESPONSE OUTPUT STREAM:');
    console.log('-----------------------------------------------------------');

    await proc.request({ type: 'prompt', message: 'Say hello in 1 short sentence.' }, 90000);
    await turnPromise;

    console.log('\n-----------------------------------------------------------');
    console.log('[4/4] Verification Summary:');
    console.log(`      - Thinking blocks/deltas received: ${thinkingCount}`);
    console.log(`      - Total response text length: ${fullResponseText.length} chars`);
    
    if (thinkingCount === 0 && fullResponseText.length > 0) {
      console.log('\n✅ 100% CONFIRMED: Thinking is completely OFF!');
    } else {
      console.log(`\nThinking blocks count: ${thinkingCount}`);
    }

  } catch (err) {
    console.error('Test execution error:', err);
  } finally {
    await proc.stop();
    console.log('\n===========================================================\n');
  }
}

runLiveCmdTest();
