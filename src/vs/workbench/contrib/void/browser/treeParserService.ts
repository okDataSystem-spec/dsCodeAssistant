/*--------------------------------------------------------------------------------------
 *  Tree-sitter 기반 코드 파싱 서비스
 *  코드 구조를 빠르게 분석하여 자동완성 품질 향상
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';

export interface ITreeParserService {
	readonly _serviceBrand: undefined;
	parseCode(code: string, language: string): Promise<ParsedContext>;
	getMethodContext(model: ITextModel, position: Position): Promise<MethodContext | null>;
}

export const ITreeParserService = createDecorator<ITreeParserService>('treeParserService');

export interface ParsedContext {
	currentFunction?: string;
	localVariables: Variable[];
	imports: string[];
	className?: string;
}

export interface Variable {
	name: string;
	type: string;
	line: number;
}

export interface MethodContext {
	methodName: string;
	parameters: Variable[];
	localVariables: Variable[];
	returnType?: string;
}

export class TreeParserService extends Disposable implements ITreeParserService {
	_serviceBrand: undefined;
	
	private parser: any = null;
	private javaLanguage: any = null;
	private typeScriptLanguage: any = null;
	private initialized = false;
	
	constructor() {
		super();
		// 브라우저 환경에서는 동적 import 사용
		this.initializeParser();
	}
	
	private async initializeParser() {
		// VS Code 환경에서는 web-tree-sitter를 직접 로드하기 어려우므로
		// 정규식 기반 파싱을 기본으로 사용
		this.initialized = true;
		console.log('OKDS Tree>> 정규식 기반 파싱 모드로 초기화');
	}
	
	async parseCode(code: string, language: string): Promise<ParsedContext> {
		// Tree-sitter가 완전히 설정되지 않았으므로 정규식 기반 파싱 사용
		return this.parseWithRegex(code, language);
	}
	
	async getMethodContext(model: ITextModel, position: Position): Promise<MethodContext | null> {
		const code = model.getValue();
		const language = this.detectLanguage(model.uri.fsPath);
		
		console.log('OKDS Tree>> 메소드 컨텍스트 분석 시작:', language);
		
		// 현재 메소드 찾기
		const methodInfo = this.findCurrentMethod(code, position);
		if (!methodInfo) {
			console.log('OKDS Tree>> 현재 위치에서 메소드를 찾을 수 없음');
			return null;
		}
		
		console.log('OKDS Tree>> 현재 메소드:', methodInfo.methodName);
		
		// 로컬 변수 추출
		const localVariables = this.extractLocalVariables(methodInfo.body, language);
		console.log('OKDS Tree>> 로컬 변수:', localVariables.length, '개');
		
		return {
			methodName: methodInfo.methodName,
			parameters: methodInfo.parameters,
			localVariables: localVariables,
			returnType: methodInfo.returnType
		};
	}
	
	private parseWithRegex(code: string, language: string): ParsedContext {
		const context: ParsedContext = {
			localVariables: [],
			imports: []
		};
		
		// Import 문 추출
		if (language === 'typescript' || language === 'javascript') {
			const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
			let match;
			while ((match = importRegex.exec(code)) !== null) {
				context.imports.push(match[1]);
			}
		} else if (language === 'java') {
			const importRegex = /import\s+([\w.]+);/g;
			let match;
			while ((match = importRegex.exec(code)) !== null) {
				context.imports.push(match[1]);
			}
		}
		
		// 클래스명 추출
		if (language === 'java') {
			const classMatch = code.match(/(?:public\s+)?class\s+(\w+)/);
			if (classMatch) {
				context.className = classMatch[1];
			}
		} else if (language === 'typescript') {
			const classMatch = code.match(/(?:export\s+)?class\s+(\w+)/);
			if (classMatch) {
				context.className = classMatch[1];
			}
		}
		
		return context;
	}
	
	private findCurrentMethod(code: string, position: Position): any {
		const lines = code.split('\n');
		const targetLine = position.lineNumber - 1; // 0-based
		
		console.log('OKDS Tree>> 메소드 찾기 시작, 현재 라인:', targetLine + 1);
		
		// Java 메소드 패턴 (더 유연하게)
		const javaMethodPatterns = [
			// 일반적인 메소드
			/(?:@\w+(?:\([^)]*\))?\s+)*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[\w\s,]+>\s+)?(\w+(?:<[^>]+>)?(?:\[\])?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w\s,]+)?\s*\{/,
			// 어노테이션이 있는 메소드
			/@\w+(?:\([^)]*\))?\s*\n\s*(?:public|private|protected)\s+(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/,
			// 접근제어자 없는 메소드 (package-private)
			/^\s*(?:static\s+)?(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w\s,]+)?\s*\{/,
			// void 메소드
			/(?:public|private|protected)\s+(?:static\s+)?(void)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w\s,]+)?\s*\{/
		];
		
		// TypeScript/JavaScript 메소드 패턴
		const tsMethodPatterns = [
			/(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*(\w+(?:<[^>]+>)?))?\s*\{/,
			/(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*(\w+(?:<[^>]+>)?))?\s*=>\s*\{/
		];
		
		let methodStart = -1;
		let methodEnd = -1;
		let methodInfo: any = null;
		
		// 현재 위치에서 위로 스캔하여 메소드 시작 찾기
		for (let i = targetLine; i >= 0; i--) {
			const line = lines[i];
			const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
			const combinedLines = line + '\n' + nextLine; // 어노테이션이 별도 줄에 있는 경우 처리
			
			// Java 메소드 체크
			for (const pattern of javaMethodPatterns) {
				let match = combinedLines.match(pattern);
				if (!match) {
					match = line.match(pattern);
				}
				
				if (match) {
					methodStart = i;
					// match 그룹 인덱스는 패턴에 따라 다를 수 있음
					const returnType = match[1] || 'void';
					const methodName = match[2];
					const params = match[3] || '';
					
					console.log('OKDS Tree>> Java 메소드 발견:', methodName, '라인:', i + 1);
					
					methodInfo = {
						methodName: methodName,
						returnType: returnType,
						parameters: this.parseParameters(params),
						startLine: i
					};
					break;
				}
			}
			
			if (methodInfo) break;
			
			// TypeScript 메소드 체크
			for (const pattern of tsMethodPatterns) {
				const match = line.match(pattern);
				if (match) {
					methodStart = i;
					console.log('OKDS Tree>> TypeScript 메소드 발견:', match[1], '라인:', i + 1);
					
					methodInfo = {
						methodName: match[1],
						returnType: match[3] || 'any',
						parameters: this.parseParameters(match[2] || ''),
						startLine: i
					};
					break;
				}
			}
			
			if (methodInfo) break;
		}
		
		if (!methodInfo) return null;
		
		// 메소드 끝 찾기 (중괄호 매칭)
		let braceCount = 0;
		let inMethod = false;
		
		for (let i = methodStart; i < lines.length; i++) {
			const line = lines[i];
			for (const char of line) {
				if (char === '{') {
					braceCount++;
					inMethod = true;
				} else if (char === '}') {
					braceCount--;
					if (inMethod && braceCount === 0) {
						methodEnd = i;
						break;
					}
				}
			}
			if (methodEnd !== -1) break;
		}
		
		if (methodEnd === -1) methodEnd = lines.length - 1;
		
		// 메소드 본문 추출
		methodInfo.body = lines.slice(methodStart, methodEnd + 1).join('\n');
		
		return methodInfo;
	}
	
	private parseParameters(paramString: string): Variable[] {
		if (!paramString.trim()) return [];
		
		const params: Variable[] = [];
		const paramParts = paramString.split(',');
		
		for (const param of paramParts) {
			const trimmed = param.trim();
			if (!trimmed) continue;
			
			// Java 스타일: Type name
			const javaMatch = trimmed.match(/(\w+(?:<[^>]+>)?)\s+(\w+)/);
			if (javaMatch) {
				params.push({
					name: javaMatch[2],
					type: javaMatch[1],
					line: 0
				});
				continue;
			}
			
			// TypeScript 스타일: name: Type
			const tsMatch = trimmed.match(/(\w+)\s*:\s*(\w+(?:<[^>]+>)?)/);
			if (tsMatch) {
				params.push({
					name: tsMatch[1],
					type: tsMatch[2],
					line: 0
				});
				continue;
			}
			
			// 타입 없는 경우
			const nameOnly = trimmed.match(/(\w+)/);
			if (nameOnly) {
				params.push({
					name: nameOnly[1],
					type: 'any',
					line: 0
				});
			}
		}
		
		return params;
	}
	
	private extractLocalVariables(methodBody: string, language: string): Variable[] {
		const variables: Variable[] = [];
		const lines = methodBody.split('\n');
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			
			if (language === 'java') {
				// Java 변수 선언: Type name = value;
				const match = line.match(/^\s*(\w+(?:<[^>]+>)?)\s+(\w+)\s*=/);
				if (match) {
					variables.push({
						name: match[2],
						type: match[1],
						line: i
					});
				}
			} else if (language === 'typescript' || language === 'javascript') {
				// TypeScript 변수 선언: const/let/var name: Type = value
				const match = line.match(/^\s*(?:const|let|var)\s+(\w+)\s*(?::\s*(\w+(?:<[^>]+>)?))?\s*=/);
				if (match) {
					variables.push({
						name: match[1],
						type: match[2] || 'any',
						line: i
					});
				}
			}
		}
		
		return variables;
	}
	
	private detectLanguage(filePath: string): string {
		if (filePath.endsWith('.java')) return 'java';
		if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
		if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript';
		return 'unknown';
	}
}

// 서비스 등록
registerSingleton(ITreeParserService, TreeParserService, InstantiationType.Eager);