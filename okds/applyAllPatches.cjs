const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Applying all OKDS patches...\n');

const patchesDir = path.join(__dirname, 'patches');

// Get all .cjs patch files
const patchFiles = fs.readdirSync(patchesDir)
    .filter(file => file.endsWith('.patch.cjs'))
    .sort();

if (patchFiles.length === 0) {
    console.log('No patch files found in okds/patches/');
    process.exit(0);
}

console.log(`Found ${patchFiles.length} patches to apply:\n`);

let successCount = 0;
let failureCount = 0;
let skippedCount = 0;

// Apply each patch
patchFiles.forEach((patchFile, index) => {
    const patchPath = path.join(patchesDir, patchFile);
    console.log(`[${index + 1}/${patchFiles.length}] Applying ${patchFile}...`);
    
    try {
        const output = execSync(`node "${patchPath}"`, { encoding: 'utf8' });
        
        if (output.includes('already applied')) {
            console.log(`  ⏭️  Skipped (already applied)\n`);
            skippedCount++;
        } else {
            console.log(`  ✅ Successfully applied\n`);
            successCount++;
        }
    } catch (error) {
        console.log(`  ❌ Failed to apply: ${error.message}\n`);
        failureCount++;
    }
});

// Summary
console.log('=' .repeat(50));
console.log('📊 Summary:');
console.log(`  ✅ Successfully applied: ${successCount}`);
console.log(`  ⏭️  Already applied: ${skippedCount}`);
console.log(`  ❌ Failed: ${failureCount}`);
console.log('=' .repeat(50));

if (successCount > 0) {
    console.log('\n🔧 Remember to run: npm run buildreact');
}

process.exit(failureCount > 0 ? 1 : 0);