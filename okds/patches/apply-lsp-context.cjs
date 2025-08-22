/**
 * LSP 기반 컨텍스트 서비스 적용 패치
 * rg.exe 없이 Language Server Protocol 활용
 */

const fs = require('fs');
const path = require('path');

console.log('===========================================');
console.log('LSP 컨텍스트 패치 적용 시작');
console.log('===========================================');

// 1. enhancedContextGatheringService 등록
const voidContribPath = path.join(__dirname, '../../src/vs/workbench/contrib/void/browser/void.contribution.ts');
let voidContrib = fs.readFileSync(voidContribPath, 'utf8');

// contextGatheringService import 주석 해제하고 enhanced로 변경
if (voidContrib.includes('// import \'./contextGatheringService.js\'')) {
    voidContrib = voidContrib.replace(
        '// import \'./contextGatheringService.js\'',
        'import \'./enhancedContextGatheringService.js\''
    );
    console.log('✅ enhancedContextGatheringService import 추가');
} else if (!voidContrib.includes('enhancedContextGatheringService')) {
    // 적절한 위치에 import 추가
    const importPos = voidContrib.indexOf('// register Autocomplete');
    if (importPos > -1) {
        voidContrib = voidContrib.slice(0, importPos) + 
            '// register Enhanced Context Service (LSP-based)\nimport \'./enhancedContextGatheringService.js\'\n\n' +
            voidContrib.slice(importPos);
        console.log('✅ enhancedContextGatheringService import 추가');
    }
}

fs.writeFileSync(voidContribPath, voidContrib);

// 2. enhancedContextGatheringService.ts 복사
const enhancedContextSource = path.join(__dirname, '../overrides/enhancedContextGatheringService.ts');
const enhancedContextDest = path.join(__dirname, '../../src/vs/workbench/contrib/void/browser/enhancedContextGatheringService.ts');

if (fs.existsSync(enhancedContextSource)) {
    fs.copyFileSync(enhancedContextSource, enhancedContextDest);
    console.log('✅ enhancedContextGatheringService.ts 복사 완료');
}

// 3. autocompleteService.ts 수정 - LSP 컨텍스트 사용
const autocompletePath = path.join(__dirname, '../../src/vs/workbench/contrib/void/browser/autocompleteService.ts');
let autocomplete = fs.readFileSync(autocompletePath, 'utf8');

// import 추가
if (!autocomplete.includes('IEnhancedContextGatheringService')) {
    const importsEnd = autocomplete.indexOf('import { IMetricsService }');
    if (importsEnd > -1) {
        autocomplete = autocomplete.slice(0, importsEnd) + 
            'import { IEnhancedContextGatheringService } from \'./enhancedContextGatheringService.js\';\n' +
            autocomplete.slice(importsEnd);
        console.log('✅ autocompleteService에 LSP import 추가');
    }
}

// constructor에 서비스 추가
if (!autocomplete.includes('@IEnhancedContextGatheringService')) {
    const constructorMatch = autocomplete.match(/constructor\s*\([^)]*\)/);
    if (constructorMatch) {
        const oldConstructor = constructorMatch[0];
        const newConstructor = oldConstructor.replace(
            '@IMetricsService private readonly _metricsService: IMetricsService,',
            '@IMetricsService private readonly _metricsService: IMetricsService,\n\t\t@IEnhancedContextGatheringService private readonly _enhancedContextService: IEnhancedContextGatheringService,'
        );
        autocomplete = autocomplete.replace(oldConstructor, newConstructor);
        console.log('✅ autocompleteService constructor 수정');
    }
}

// relevantContext 부분 수정 - LSP 사용
const relevantContextLine = autocomplete.indexOf('const relevantContext = \'\'');
if (relevantContextLine > -1) {
    autocomplete = autocomplete.replace(
        'const relevantContext = \'\'',
        `// LSP 기반 컨텍스트 수집
\t\tlet relevantContext = '';
\t\ttry {
\t\t\tconsole.log('OKDS LSP LOG>> 자동완성 LSP 컨텍스트 수집 시작');
\t\t\trelevantContext = await this._enhancedContextService.gatherSmartContext(model, position);
\t\t\tconsole.log('OKDS LSP LOG>> 자동완성 LSP 컨텍스트 크기:', relevantContext.length);
\t\t} catch (e) {
\t\t\tconsole.error('OKDS LSP LOG>> 자동완성 LSP 컨텍스트 수집 실패:', e);
\t\t\trelevantContext = '';
\t\t}`
    );
    console.log('✅ autocompleteService relevantContext LSP 사용으로 변경');
}

fs.writeFileSync(autocompletePath, autocomplete);

// 4. convertToLLMMessageService 수정 - LSP 컨텍스트 추가
const convertPath = path.join(__dirname, '../../src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts');
let convert = fs.readFileSync(convertPath, 'utf8');

// import 추가
if (!convert.includes('IEnhancedContextGatheringService')) {
    const importsEnd = convert.indexOf('import { IMCPService }');
    if (importsEnd > -1) {
        convert = convert.slice(0, importsEnd) + 
            'import { IEnhancedContextGatheringService } from \'./enhancedContextGatheringService.js\';\n' +
            'import { ICodeEditorService } from \'../../../../editor/browser/services/codeEditorService.js\';\n' +
            'import { Position } from \'../../../../editor/common/core/position.js\';\n' +
            convert.slice(importsEnd);
        console.log('✅ convertToLLMMessageService에 LSP import 추가');
    }
}

// constructor에 서비스 추가
if (!convert.includes('@IEnhancedContextGatheringService')) {
    const constructorMatch = convert.match(/constructor\s*\([^{]*{/s);
    if (constructorMatch) {
        const oldConstructor = constructorMatch[0];
        const newConstructor = oldConstructor.replace(
            '@IMCPService private readonly mcpService: IMCPService,',
            '@IMCPService private readonly mcpService: IMCPService,\n\t\t@IEnhancedContextGatheringService private readonly enhancedContextService: IEnhancedContextGatheringService,\n\t\t@ICodeEditorService private readonly codeEditorService: ICodeEditorService,'
        );
        convert = convert.replace(oldConstructor, newConstructor);
        console.log('✅ convertToLLMMessageService constructor 수정');
    }
}

// _generateChatMessagesSystemMessage 수정 - LSP 컨텍스트 추가
const systemMessageFunc = convert.indexOf('private async _generateChatMessagesSystemMessage');
if (systemMessageFunc > -1) {
    // 함수 끝 찾기
    const funcEnd = convert.indexOf('return systemMessage', systemMessageFunc);
    if (funcEnd > -1) {
        const beforeReturn = convert.slice(0, funcEnd);
        const afterReturn = convert.slice(funcEnd);
        
        const lspContextCode = `
\t\t// LSP 기반 스마트 컨텍스트 추가
\t\tlet lspContext = '';
\t\ttry {
\t\t\tconst activeEditor = this.codeEditorService.getFocusedCodeEditor();
\t\t\tif (activeEditor && activeEditor.getModel()) {
\t\t\t\tconst model = activeEditor.getModel();
\t\t\t\tconst position = activeEditor.getPosition() || new Position(1, 1);
\t\t\t\tconsole.log('OKDS LSP LOG>> 채팅 LSP 컨텍스트 수집 시작');
\t\t\t\tlspContext = await this.enhancedContextService.gatherSmartContext(model, position);
\t\t\t\tconsole.log('OKDS LSP LOG>> 채팅 LSP 컨텍스트 크기:', lspContext.length);
\t\t\t}
\t\t} catch (e) {
\t\t\tconsole.error('OKDS LSP LOG>> 채팅 LSP 컨텍스트 수집 실패:', e);
\t\t}
\t\t
\t\tif (lspContext) {
\t\t\tsystemMessage += '\\n\\n=== LSP 기반 프로젝트 컨텍스트 ===\\n' + lspContext;
\t\t\tconsole.log('OKDS LSP LOG>> 시스템 메시지에 LSP 컨텍스트 추가 완료');
\t\t}
\t\t
\t\t`;
        
        convert = beforeReturn + lspContextCode + afterReturn;
        console.log('✅ convertToLLMMessageService에 LSP 컨텍스트 로직 추가');
    }
}

fs.writeFileSync(convertPath, convert);

console.log('===========================================');
console.log('✅ LSP 컨텍스트 패치 적용 완료!');
console.log('');
console.log('다음 명령어로 빌드하세요:');
console.log('npm run compile');
console.log('');
console.log('콘솔에서 "OKDS LSP LOG>>" 로그를 확인할 수 있습니다.');
console.log('===========================================');