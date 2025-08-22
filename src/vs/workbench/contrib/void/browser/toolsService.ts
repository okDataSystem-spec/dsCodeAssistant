import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { CancellationTokenSource } from '../../../../base/common/cancellation.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'


// Dify Helper Functions
type QueryType = 'className' | 'methodName' | 'businessLogic' | 'fileName' | 'general';

function analyzeQueryType(query: string): QueryType {
	// 파일명 검색 (확장자 포함)
	if (query.match(/\.(java|dbio|xml)$/)) {
		return 'fileName';
	}
	
	// 한글 포함 - 비즈니스 로직 검색
	if (/[가-힣]/.test(query)) {
		return 'businessLogic';
	}
	
	// 메소드명 패턴 (get/set/is로 시작, camelCase)
	if (/^(get|set|is|has|add|remove|update|delete|find|search)[A-Z]/.test(query)) {
		return 'methodName';
	}
	
	// 클래스명 패턴 (PascalCase, Service/DAO/VO/DTO 등으로 끝남)
	if (/^[A-Z][a-zA-Z0-9]*(Service|DAO|VO|DTO|Controller|Manager|Handler|Helper|Util)$/.test(query)) {
		return 'className';
	}
	
	// PascalCase 일반
	if (/^[A-Z][a-z][a-zA-Z0-9]*$/.test(query)) {
		return 'className';
	}
	
	return 'general';
}

interface DifyResultItem {
	metadata: {
		score: number;
		document_name?: string;
		[key: string]: any;
	};
	title: string;
	content: string;
}

interface DifySearchResult {
	uris: URI[];
	confidence: 'high' | 'medium' | 'low';  // 결과 신뢰도
	avgScore: number;  // 평균 유사도 점수
}

async function searchWithDify(
	query: string, 
	queryType: QueryType,
	voidSettingsService: IVoidSettingsService
): Promise<DifySearchResult> {
	const settings = voidSettingsService.state.settingsOfProvider.dify;
	
	if (!settings?.apiKey) {
		console.log('OKDS DIFY WARNING>> API key not configured');
		console.log('OKDS DIFY WARNING>> Skipping Dify search');
		return { uris: [], confidence: 'low', avgScore: 0 };
	}
	
	const requestBody = {
		query: query,
		inputs: {
			bGubun: "Search",
			search_type: queryType,
			file_type: "java,dbio,xml",  // 모든 타입 포함
			query_embedding: true,
			return_count: 20,
			similarity_threshold: 0.7
		},
		response_mode: "streaming",
		user: `void_${Date.now()}`  // 타임스탬프를 사용자 ID로 사용
	};
	
	try {
		console.log('OKDS DIFY TODO>> Starting Dify search');
		console.log('OKDS DIFY TODO>> Query:', query);
		console.log('OKDS DIFY TODO>> Type:', queryType);
		console.log('OKDS DIFY TODO>> Endpoint:', settings.endpoint);
		console.log('OKDS DIFY TODO>> Request Body:', JSON.stringify(requestBody, null, 2));
		
		const response = await fetch(`${settings.endpoint}/v1/chat-messages`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${settings.apiKey}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'User-Agent': 'Void-Assistant/1.0'
			},
			body: JSON.stringify(requestBody)
		});
		
		if (!response.ok) {
			console.error('OKDS DIFY ERROR>> API request failed');
			console.error('OKDS DIFY ERROR>> Status:', response.status);
			console.error('OKDS DIFY ERROR>> StatusText:', response.statusText);
			return { uris: [], confidence: 'low', avgScore: 0 };
		}
		
		// SSE 스트림 파싱
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		const results: URI[] = [];
		const scores: number[] = [];
		let buffer = '';
		
		if (!reader) {
			console.error('[Dify] No response body reader');
			return { uris: [], confidence: 'low', avgScore: 0 };
		}
		
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || ''; // 마지막 불완전한 라인은 버퍼에 보관
			
			for (const line of lines) {
				if (line.trim() === '') continue; // 빈 줄 무시
				
				console.log('OKDS DIFY RAW>> Line:', line);
				
				if (line.startsWith('data: ')) {
					try {
						const dataStr = line.slice(6);
						console.log('OKDS DIFY RAW>> Parsing data:', dataStr);
						const data = JSON.parse(dataStr);
						
						// Dify 지식 검색 결과 형식 처리
						if (data.result && Array.isArray(data.result)) {
							console.log('OKDS DIFY PARSE>> Found knowledge search result array:', data.result.length, 'items');
							data.result.forEach((item: DifyResultItem, index: number) => {
								// content에서 file_path 추출
								const filePathMatch = item.content.match(/file_path:\s*([^\n]+)/);
								if (filePathMatch && filePathMatch[1]) {
									const filePath = filePathMatch[1].trim();
									results.push(URI.file(filePath));
									console.log(`OKDS DIFY PARSE>> Item ${index + 1}: ${filePath} (score: ${item.metadata?.score?.toFixed(3) || 'N/A'})`);
									
									// 유사도 점수 저장
									if (item.metadata?.score) {
										scores.push(item.metadata.score);
									}
								}
							});
						}
						// 기존 workflow_finished 형식도 지원
						else if (data.event === 'workflow_finished' && data.data?.outputs?.answer) {
							console.log('OKDS DIFY PARSE>> Found workflow_finished event');
							console.log('OKDS DIFY PARSE>> Answer:', data.data.outputs.answer.substring(0, 200));
							const searchResults = parseFilePathsFromAnswer(data.data.outputs.answer);
							console.log('OKDS DIFY PARSE>> Extracted results:', searchResults.length);
							
							searchResults.forEach(result => {
								console.log('OKDS DIFY PARSE>> Path:', result.path, 'Score:', result.score);
								results.push(URI.file(result.path));
								scores.push(result.score);
							});
							
							if (searchResults.length > 0) {
								const avgScoreCalc = searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length;
								console.log('OKDS DIFY PARSE>> Average score:', avgScoreCalc);
							}
						}
						// 다른 이벤트 타입 로깅
						else if (data.event) {
							console.log('OKDS DIFY PARSE>> Other event type:', data.event);
							if (data.answer) {
								console.log('OKDS DIFY PARSE>> Has answer, length:', data.answer.length);
							}
						}
						// 일반 message 형식도 지원
						else if ((data.event === 'message' || data.event === 'agent_message') && data.answer) {
							console.log('OKDS DIFY PARSE>> Found message event with answer');
							console.log('OKDS DIFY PARSE>> Answer:', data.answer.substring(0, 200)); // 처음 200자만
							
							// JSON 형식의 결과인지 확인
							try {
								const jsonResult = JSON.parse(data.answer);
								console.log('OKDS DIFY PARSE>> Parsed as JSON successfully');
								if (jsonResult.result && Array.isArray(jsonResult.result)) {
									console.log('OKDS DIFY PARSE>> Found result array in answer:', jsonResult.result.length, 'items');
									jsonResult.result.forEach((item: DifyResultItem) => {
										const filePathMatch = item.content.match(/file_path:\s*([^\n]+)/);
										if (filePathMatch && filePathMatch[1]) {
											const filePath = filePathMatch[1].trim();
											results.push(URI.file(filePath));
											
											if (item.metadata?.score) {
												scores.push(item.metadata.score);
											}
										}
									});
								}
							} catch (e) {
								// JSON이 아닌 경우 기존 방식으로 파싱
								console.log('OKDS DIFY PARSE>> Not JSON, trying text parsing');
								const fileResults = parseFilePathsFromAnswer(data.answer);
								console.log('OKDS DIFY PARSE>> Extracted paths from text:', fileResults.length);
								fileResults.forEach(fileInfo => {
									console.log('OKDS DIFY PARSE>> Text path:', fileInfo.path, 'Score:', fileInfo.score);
									results.push(URI.file(fileInfo.path));
									scores.push(fileInfo.score);
								});
							}
						}
					} catch (e) {
						console.error('[Dify] Failed to parse SSE data:', e);
					}
				}
			}
		}
		
		// 평균 유사도 점수 계산
		const avgScore = scores.length > 0 
			? scores.reduce((a, b) => a + b, 0) / scores.length 
			: 0;
		
		// 유사도 점수 기반 신뢰도 판단
		let confidence: 'high' | 'medium' | 'low';
		if (avgScore >= 0.8 || results.length >= 10) {
			confidence = 'high';
		} else if (avgScore >= 0.7 || results.length >= 3) {
			confidence = 'medium';
		} else {
			confidence = 'low';
		}
		
		console.log('OKDS DIFY RESULT>> Search completed');
		console.log('OKDS DIFY RESULT>> Found:', results.length, 'files');
		console.log('OKDS DIFY RESULT>> Avg Score:', avgScore.toFixed(3));
		console.log('OKDS DIFY RESULT>> Confidence:', confidence);
		if (scores.length > 0) {
			console.log('OKDS DIFY RESULT>> Individual Scores:', scores.map(s => s.toFixed(3)).join(', '));
		}
		if (results.length > 0) {
			console.log('OKDS DIFY RESULT>> Files:', results.map(uri => uri.fsPath).join('\n  '));
		}
		
		return { uris: results, confidence, avgScore };
		
	} catch (error) {
		console.error('OKDS DIFY ERROR>> Search failed:', error);
		return { uris: [], confidence: 'low', avgScore: 0 };
	}
}

// 응답에서 파일 경로와 스코어 추출
interface DifyFileInfo {
	path: string;
	score: number;
}

function parseFilePathsFromAnswer(answer: string): DifyFileInfo[] {
	const results: DifyFileInfo[] = [];
	const seenPaths = new Set<string>();
	
	try {
		// workflow_finished 형식 처리 (전체가 하나의 JSON)
		if (answer.trim().startsWith('{') && answer.includes('"metadata"')) {
			try {
				const obj = JSON.parse(answer);
				if (obj.content && obj.metadata) {
					// file_path 찾기
					const filePathMatch = obj.content.match(/file_path:\s*([^\n]+)/);
					if (filePathMatch) {
						let filePath = filePathMatch[1].trim();
						// 경로 정규화 (앞의 / 제거)
						filePath = filePath.replace(/^\/+/, '');
						
						if (!seenPaths.has(filePath)) {
							seenPaths.add(filePath);
							results.push({
								path: filePath,
								score: obj.metadata.score || 0
							});
							console.log('OKDS DIFY PARSE DETAIL>> Extracted:', filePath, 'Score:', obj.metadata.score);
						}
					}
				}
			} catch (e) {
				console.log('OKDS DIFY PARSE DETAIL>> Single JSON parse failed:', e);
			}
		}
		
		// 여러 JSON 객체가 줄바꿈으로 구분된 경우
		if (results.length === 0 && answer.includes('"file_path"')) {
			// JSON 객체들을 개별적으로 파싱
			const jsonObjects = answer.split('\n').filter(line => line.trim().startsWith('{'));
			
			for (const jsonStr of jsonObjects) {
				try {
					const obj = JSON.parse(jsonStr);
					if (obj.content && obj.metadata) {
						// file_path 찾기
						const filePathMatch = obj.content.match(/file_path:\s*([^\n]+)/);
						if (filePathMatch) {
							let filePath = filePathMatch[1].trim();
							// 경로 정규화 (앞의 / 제거)
							filePath = filePath.replace(/^\/+/, '');
							
							if (!seenPaths.has(filePath)) {
								seenPaths.add(filePath);
								results.push({
									path: filePath,
									score: obj.metadata.score || 0
								});
							}
						}
					}
				} catch (e) {
					// 개별 JSON 파싱 실패 시 무시
				}
			}
		}
		
		// 기존 패턴 매칭 (fallback)
		if (results.length === 0) {
			const lines = answer.split('\n');
			for (const line of lines) {
				const patterns = [
					/([A-Za-z]:)?[\/\\]?[\w\-\.\/\\]+\.(java|dbio|xml)(?::\d+)?/g
				];
				
				for (const pattern of patterns) {
					const matches = line.matchAll(pattern);
					for (const match of matches) {
						let path = match[0].replace(/:\d+$/, '').replace(/^\/+/, '');
						if (!seenPaths.has(path)) {
							seenPaths.add(path);
							results.push({ path, score: 0 });
						}
					}
				}
			}
		}
	} catch (error) {
		console.error('OKDS DIFY PARSE ERROR>>', error);
	}
	
	return results;
}


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				// 1. 쿼리 타입 분석
				const queryType = analyzeQueryType(queryStr);
				console.log('OKDS SEARCH START>> Query:', queryStr);
				console.log('OKDS SEARCH START>> Type:', queryType);
				console.log('OKDS SEARCH START>> IsRegex:', isRegex);
				
				// 2. Dify 검색 시도 (정규식이 아니고, 적합한 쿼리 타입인 경우)
				let difyResult: DifySearchResult = { uris: [], confidence: 'low', avgScore: 0 };
				let shouldUseRipgrep = true;  // 기본적으로 ripgrep 사용
				
				if (!isRegex && (queryType === 'className' || queryType === 'methodName' || queryType === 'businessLogic')) {
					console.log('OKDS SEARCH TODO>> Will attempt Dify search for', queryType);
					difyResult = await searchWithDify(queryStr, queryType, voidSettingsService);
					
					// 유사도 점수 기반으로 ripgrep 사용 여부 결정
					if (difyResult.avgScore >= 0.75 && difyResult.uris.length > 0) {
						// 높은 유사도 (0.75 이상): Dify 결과만 사용
						shouldUseRipgrep = false;
						console.log('OKDS SEARCH DECISION>> High similarity:', difyResult.avgScore.toFixed(3));
						console.log('OKDS SEARCH DECISION>> Strategy: Dify ONLY');
					} else if (difyResult.avgScore >= 0.65 && difyResult.uris.length >= 3) {
						// 중간 유사도 (0.65-0.75) + 충분한 결과: Dify만 사용
						shouldUseRipgrep = false;
						console.log('OKDS SEARCH DECISION>> Medium similarity:', difyResult.avgScore.toFixed(3));
						console.log('OKDS SEARCH DECISION>> Strategy: Dify ONLY (sufficient results)');
					} else if (difyResult.uris.length === 0) {
						// Dify 결과 없음: ripgrep만 사용
						console.log('OKDS SEARCH DECISION>> No Dify results');
						console.log('OKDS SEARCH DECISION>> Strategy: Ripgrep ONLY');
					} else {
						// 낮은 유사도: 둘 다 사용
						console.log('OKDS SEARCH DECISION>> Low similarity:', difyResult.avgScore.toFixed(3));
						console.log('OKDS SEARCH DECISION>> Strategy: Dify + Ripgrep MERGE');
					}
				} else {
					console.log('OKDS SEARCH TODO>> Skipping Dify (regex or unsuitable type)');
				}
				
				// 3. 필요한 경우에만 Ripgrep 검색 실행
				let ripgrepUris: URI[] = [];
				
				if (shouldUseRipgrep) {
					console.log('OKDS RIPGREP START>> Executing ripgrep search');
					
					const searchFolders = searchInFolder === null ?
						workspaceContextService.getWorkspace().folders.map(f => f.uri)
						: [searchInFolder]

					// 파일 타입별 스마트 검색 - .dbio, .xml 추가
					const isCodeSearch = queryStr.includes('class') || queryStr.includes('Service') || 
						queryStr.includes('DAO') || queryStr.includes('Controller') || 
						queryStr.includes('Manager') || queryStr.includes('Helper');
					
					// .java, .dbio, .xml 모두 포함
					const includePattern = isCodeSearch ? '**/*.{java,dbio,xml}' : undefined;
					
					const query = queryBuilder.text({
						pattern: queryStr,
						isRegExp: isRegex,
					}, searchFolders, {
						maxResults: 200,  // 결과를 200개로 제한
						includePattern: includePattern,  // 코드 검색시 .java, .dbio, .xml 파일
						excludePattern: [
							// 최소한의 제외 패턴만 (배열 형식)
							{ pattern: '**/*.class' },
							{ pattern: '**/*.jar' },
							{ pattern: '**/target/**' },
							{ pattern: '**/build/**' },
							{ pattern: '**/node_modules/**' },
							{ pattern: '**/.git/**' },
						]
					})

					// 타임아웃 설정으로 무한 대기 방지
					const cts = new CancellationTokenSource();
					setTimeout(() => cts.cancel(), 30000); // 30초 타임아웃

					const data = await searchService.textSearch(query, cts.token);
					ripgrepUris = data.results.map(({ resource }) => resource);
					console.log('OKDS RIPGREP RESULT>> Found:', ripgrepUris.length, 'files');
				}
				
				// 4. 결과 병합 (필요한 경우에만)
				let allUris: URI[];
				
				if (!shouldUseRipgrep) {
					// Dify 결과만 사용
					allUris = difyResult.uris;
					console.log('OKDS SEARCH FINAL>> Using Dify results ONLY');
					console.log('OKDS SEARCH FINAL>> Total files:', allUris.length);
				} else if (difyResult.uris.length === 0) {
					// Ripgrep 결과만 사용
					allUris = ripgrepUris;
					console.log('OKDS SEARCH FINAL>> Using Ripgrep results ONLY');
					console.log('OKDS SEARCH FINAL>> Total files:', allUris.length);
				} else {
					// 둘 다 있는 경우 병합 (Dify 우선, 중복 제거)
					allUris = [...difyResult.uris];
					const difyPaths = new Set(difyResult.uris.map(uri => uri.fsPath));
					
					for (const uri of ripgrepUris) {
						if (!difyPaths.has(uri.fsPath)) {
							allUris.push(uri);
						}
					}
					console.log('OKDS SEARCH FINAL>> MERGED results');
					console.log('OKDS SEARCH FINAL>> Dify files:', difyResult.uris.length);
					console.log('OKDS SEARCH FINAL>> Ripgrep files:', ripgrepUris.length);
					console.log('OKDS SEARCH FINAL>> Total after merge:', allUris.length);
				}

				// 5. 페이지네이션
				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
				const uris = allUris.slice(fromIdx, toIdx + 1);
				const hasNextPage = (allUris.length - 1) - toIdx >= 1;
				
				return { result: { queryStr, uris, hasNextPage } };
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await voidModelService.initializeModel(uri);
				const { model } = await voidModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voidModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
