/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// OKDS Override: Enhanced @ mention to show workspace folders directly

import { URI } from '../../../../../../../base/common/uri.js';
import { File, Folder } from 'lucide-react';

// This function should be integrated into getOptionsAtPath in inputs.tsx
export const getWorkspaceFoldersAsOptions = (accessor: any): any[] => {
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceFolders = workspaceService.getWorkspace().folders;
	
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return [];
	}
	
	// Create options for each workspace folder
	const workspaceFolderOptions = workspaceFolders.map((folder: any) => {
		const folderName = folder.name || folder.uri.path.split('/').pop() || 'Workspace';
		
		return {
			fullName: folderName,
			abbreviatedName: folderName,
			iconInMenu: Folder,
			leafNodeType: 'Folder',
			uri: folder.uri,
		};
	});
	
	return workspaceFolderOptions;
};

// Enhanced allOptions array that includes workspace folders at root
export const enhancedGetOptionsAtPath = async (accessor: any, path: string[], optionText: string): Promise<any[]> => {
	const toolsService = accessor.get('IToolsService');
	
	// ... (keep existing searchForFilesOrFolders function)
	const searchForFilesOrFolders = async (t: string, searchFor: 'files' | 'folders') => {
		// ... (existing implementation)
	};
	
	// Get workspace folders directly
	const workspaceFolderOptions = getWorkspaceFoldersAsOptions(accessor);
	
	// Enhanced root options with workspace folders
	const allOptions: any[] = [
		{
			fullName: 'files',
			abbreviatedName: 'files',
			iconInMenu: File,
			generateNextOptions: async (t: any) => (await searchForFilesOrFolders(t, 'files')) || [],
		},
		{
			fullName: 'folders',
			abbreviatedName: 'folders',
			iconInMenu: Folder,
			generateNextOptions: async (t: any) => (await searchForFilesOrFolders(t, 'folders')) || [],
		},
		// Add workspace folders directly at root level
		...workspaceFolderOptions,
	];
	
	// When path is empty (user just typed @), show all root options including workspace folders
	if (path.length === 0) {
		// Filter based on optionText if provided
		if (optionText.trim().length > 0) {
			// Include search results plus filtered workspace folders
			const filesResults = await searchForFilesOrFolders(optionText, 'files') || [];
			const foldersResults = await searchForFilesOrFolders(optionText, 'folders') || [];
			const filteredWorkspaceFolders = workspaceFolderOptions.filter(o => 
				o.fullName.toLowerCase().includes(optionText.toLowerCase())
			);
			return [...filteredWorkspaceFolders, ...foldersResults, ...filesResults];
		} else {
			// Show all root options when no search text
			return allOptions;
		}
	}
	
	// ... (rest of the existing logic for following paths)
	
	return [];
};