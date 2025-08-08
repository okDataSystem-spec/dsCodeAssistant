const fs = require('fs');
const path = require('path');

console.log('📁 Applying @ mention workspace folders patch...');

const inputsFilePath = path.join(__dirname, '../../src/vs/workbench/contrib/void/browser/react/src/util/inputs.tsx');

// Read the current file
let content = fs.readFileSync(inputsFilePath, 'utf8');

// Check if patch is already applied
if (content.includes('// OKDS: Add workspace folders directly')) {
    console.log('✅ Patch already applied');
    process.exit(0);
}

// Find the allOptions array and add workspace folders
const allOptionsPattern = /const allOptions: Option\[\] = \[[\s\S]*?\]/;
const allOptionsMatch = content.match(allOptionsPattern);

if (!allOptionsMatch) {
    console.error('❌ Could not find allOptions array');
    process.exit(1);
}

// Create the enhanced allOptions with workspace folders
const enhancedAllOptions = `	// OKDS: Add workspace folders directly
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceFolders = workspaceService.getWorkspace().folders;
	
	const workspaceFolderOptions: Option[] = workspaceFolders.map(folder => {
		const folderName = folder.name || folder.uri.path.split('/').pop() || 'Workspace';
		return {
			fullName: folderName,
			abbreviatedName: folderName,
			iconInMenu: Folder,
			leafNodeType: 'Folder' as const,
			uri: folder.uri,
		};
	});

	const allOptions: Option[] = [
		{
			fullName: 'files',
			abbreviatedName: 'files',
			iconInMenu: File,
			generateNextOptions: async (t) => (await searchForFilesOrFolders(t, 'files')) || [],
		},
		{
			fullName: 'folders',
			abbreviatedName: 'folders',
			iconInMenu: Folder,
			generateNextOptions: async (t) => (await searchForFilesOrFolders(t, 'folders')) || [],
		},
		// OKDS: Include workspace folders at root level
		...workspaceFolderOptions,
	]`;

// Replace the original allOptions with enhanced version
content = content.replace(allOptionsPattern, enhancedAllOptions);

// Also update the special case for empty path to include workspace folders
const specialCasePattern = /else if \(path\.length === 0 && optionText\.trim\(\)\.length > 0\) \{[\s\S]*?nextOptionsAtPath = \[\.\.\.foldersResults, \.\.\.filesResults,\]/;
const specialCaseReplacement = `else if (path.length === 0 && optionText.trim().length > 0) { // (special case): directly search for both files and folders if optionsPath is empty and there's a search term
		const filesResults = await searchForFilesOrFolders(optionText, 'files') || [];
		const foldersResults = await searchForFilesOrFolders(optionText, 'folders') || [];
		// OKDS: Also filter workspace folders by search text
		const filteredWorkspaceFolders = workspaceFolderOptions.filter(o => 
			o.fullName.toLowerCase().includes(optionText.toLowerCase())
		);
		nextOptionsAtPath = [...filteredWorkspaceFolders, ...foldersResults, ...filesResults,]`;

if (content.includes('else if (path.length === 0 && optionText.trim().length > 0)')) {
    content = content.replace(specialCasePattern, specialCaseReplacement);
}

// Write the modified content back
fs.writeFileSync(inputsFilePath, content, 'utf8');

console.log('✅ @ mention workspace folders patch applied successfully!');
console.log('📝 Modified file:', inputsFilePath);