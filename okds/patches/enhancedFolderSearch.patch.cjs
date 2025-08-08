const fs = require('fs');
const path = require('path');

console.log('📁 Applying enhanced folder search patch...');

const inputsFilePath = path.join(__dirname, '../../src/vs/workbench/contrib/void/browser/react/src/util/inputs.tsx');

// Read the current file
let content = fs.readFileSync(inputsFilePath, 'utf8');

// Check if patch is already applied
if (content.includes('// OKDS: Enhanced folder search')) {
    console.log('✅ Patch already applied');
    process.exit(0);
}

// 1. Replace the searchForFilesOrFolders function with enhanced version
const searchForFilesOrFoldersPattern = /const searchForFilesOrFolders = async \(t: string, searchFor: 'files' \| 'folders'\) => \{[\s\S]*?\n\t\};/;

const enhancedSearchForFilesOrFolders = `const searchForFilesOrFolders = async (t: string, searchFor: 'files' | 'folders') => {
		try {

			if (searchFor === 'files') {
				const searchResults = (await (await toolsService.callTool.search_pathnames_only({
					query: t,
					includePattern: null,
					pageNumber: 1,
				})).result).uris
				
				const res: Option[] = searchResults.map(uri => {
					const relativePath = getRelativeWorkspacePath(accessor, uri)
					return {
						leafNodeType: 'File',
						uri: uri,
						iconInMenu: File,
						fullName: relativePath,
						abbreviatedName: getAbbreviatedName(relativePath),
					}
				})
				return res
			}

			else if (searchFor === 'folders') {
				// OKDS: Enhanced folder search - Get all folders, not just from file results
				const directoryMap = new Map<string, URI>();
				const workspaceService = accessor.get('IWorkspaceContextService');
				const workspaceFolders = workspaceService.getWorkspace().folders;
				
				// If search text is empty, get all folders recursively
				if (!t || t.trim() === '') {
					// Get all folders from workspace
					for (const workspaceFolder of workspaceFolders) {
						try {
							// List directory contents
							const lsResult = await (await toolsService.callTool.ls_dir({
								uri: workspaceFolder.uri,
								pageNumber: 1
							})).result;
							
							if (lsResult.children) {
								// Add all directories from ls_dir result
								for (const child of lsResult.children) {
									if (child.isDirectory) {
										const folderUri = URI.joinPath(workspaceFolder.uri, child.name);
										const relativePath = getRelativeWorkspacePath(accessor, folderUri);
										directoryMap.set(relativePath, folderUri);
										
										// Recursively get subdirectories (limited depth)
										await addSubdirectories(folderUri, directoryMap, 2);
									}
								}
							}
						} catch (err) {
							console.warn('Error getting directory listing:', err);
						}
					}
				} else {
					// Search for folders by name
					// First try to search for files with the pattern and extract folders
					const searchResults = (await (await toolsService.callTool.search_pathnames_only({
						query: \`*\${t}*\`,  // Search for folder names containing the text
						includePattern: null,
						pageNumber: 1,
					})).result).uris;

					// Extract unique directory paths from search results
					for (const uri of searchResults) {
						if (!uri) continue;
						const relativePath = getRelativeWorkspacePath(accessor, uri);
						const pathParts = relativePath.split('/');
						
						// Find workspace folder for this URI
						let workspaceFolderUri: URI | undefined;
						for (const folder of workspaceFolders) {
							if (uri.fsPath.startsWith(folder.uri.fsPath)) {
								workspaceFolderUri = folder.uri;
								break;
							}
						}
						
						if (workspaceFolderUri) {
							// Add all parent directories that match search
							let currentPath = '';
							for (let i = 0; i < pathParts.length - 1; i++) {
								if (i === 0) {
									currentPath = pathParts[i];
								} else {
									currentPath = \`\${currentPath}/\${pathParts[i]}\`;
								}
								
								// Only add if folder name matches search text
								const folderName = pathParts[i];
								if (folderName.toLowerCase().includes(t.toLowerCase())) {
									const directoryUri = URI.joinPath(workspaceFolderUri, currentPath);
									directoryMap.set(currentPath, directoryUri);
								}
							}
						}
					}
					
					// Also search in workspace root folders
					for (const workspaceFolder of workspaceFolders) {
						try {
							const lsResult = await (await toolsService.callTool.ls_dir({
								uri: workspaceFolder.uri,
								pageNumber: 1
							})).result;
							
							if (lsResult.children) {
								for (const child of lsResult.children) {
									if (child.isDirectory && child.name.toLowerCase().includes(t.toLowerCase())) {
										const folderUri = URI.joinPath(workspaceFolder.uri, child.name);
										const relativePath = getRelativeWorkspacePath(accessor, folderUri);
										directoryMap.set(relativePath, folderUri);
									}
								}
							}
						} catch (err) {
							console.warn('Error listing directory:', err);
						}
					}
				}
				
				// Convert map to array and sort by path
				const folders = Array.from(directoryMap.entries())
					.map(([relativePath, uri]) => ({
						leafNodeType: 'Folder' as const,
						uri: uri,
						iconInMenu: Folder,
						fullName: relativePath,
						abbreviatedName: getAbbreviatedName(relativePath),
					}))
					.sort((a, b) => a.fullName.localeCompare(b.fullName));
				
				return folders;
			}
		} catch (error) {
			console.error('Error fetching directories:', error);
			return [];
		}
		
		// Helper function to recursively add subdirectories
		async function addSubdirectories(parentUri: URI, map: Map<string, URI>, depth: number) {
			if (depth <= 0) return;
			
			try {
				const lsResult = await (await toolsService.callTool.ls_dir({
					uri: parentUri,
					pageNumber: 1
				})).result;
				
				if (lsResult.children) {
					for (const child of lsResult.children) {
						if (child.isDirectory) {
							const folderUri = URI.joinPath(parentUri, child.name);
							const relativePath = getRelativeWorkspacePath(accessor, folderUri);
							map.set(relativePath, folderUri);
							
							// Recursive call with reduced depth
							await addSubdirectories(folderUri, map, depth - 1);
						}
					}
				}
			} catch (err) {
				// Silently ignore errors in subdirectories
			}
		}
	};`;

// Replace the function
content = content.replace(searchForFilesOrFoldersPattern, enhancedSearchForFilesOrFolders);

// Write the modified content back
fs.writeFileSync(inputsFilePath, content, 'utf8');

console.log('✅ Enhanced folder search patch applied successfully!');
console.log('📝 Modified file:', inputsFilePath);
console.log('🔧 Remember to run: npm run buildreact');