// GPT OSS Harmony Integration Test
// This script can be pasted in browser console when Void is running

console.log('=== GPT OSS Harmony Integration Test ===');

// Test 1: Check if GPT OSS provider is available in model capabilities
try {
  const modelCaps = require('./src/vs/workbench/contrib/void/common/modelCapabilities.ts');
  console.log('✅ Model capabilities loaded');
  
  if (modelCaps.modelCapabilities.gptOSS) {
    console.log('✅ GPT OSS provider found in model capabilities');
    console.log('GPT OSS config:', modelCaps.modelCapabilities.gptOSS);
  } else {
    console.log('❌ GPT OSS provider not found in model capabilities');
  }
} catch (e) {
  console.log('❌ Failed to load model capabilities:', e.message);
}

// Test 2: Check if HarmonyEncoder is available
try {
  const harmonyEncoder = require('./src/vs/workbench/contrib/void/electron-main/llmMessage/harmonyEncoder.ts');
  console.log('✅ HarmonyEncoder loaded');
  
  if (harmonyEncoder.HarmonyEncoder) {
    console.log('✅ HarmonyEncoder class available');
    
    // Test basic functionality
    const testMessage = {
      role: 'user',
      content: 'Hello world'
    };
    
    const rendered = harmonyEncoder.HarmonyEncoder.renderMessage(testMessage);
    console.log('✅ Message rendering test:', rendered);
  }
} catch (e) {
  console.log('❌ Failed to load HarmonyEncoder:', e.message);
}

// Test 3: Check if GPT OSS shows up in settings types
try {
  const settingsTypes = require('./src/vs/workbench/contrib/void/common/voidSettingsTypes.ts');
  console.log('✅ Settings types loaded');
  
  // Check if GPT OSS provider info function exists
  if (settingsTypes.displayInfoOfProviderName) {
    const gptOSSInfo = settingsTypes.displayInfoOfProviderName('gptOSS');
    console.log('✅ GPT OSS display info:', gptOSSInfo);
  }
} catch (e) {
  console.log('❌ Failed to load settings types:', e.message);
}

console.log('=== Test Complete ===');