// Void 자동완성 상태 확인 스크립트
// F12 개발자 콘솔에서 실행

(async () => {
    const accessor = require('vs/platform/instantiation/common/instantiation').ServiceCollection._globalRegistry._services;
    
    // Settings Service 가져오기
    const settingsService = accessor.get('IVoidSettingsService')?.[0];
    if (!settingsService) {
        console.error('❌ Void Settings Service를 찾을 수 없습니다');
        return;
    }
    
    const state = settingsService.state;
    console.log('=== Void 자동완성 설정 상태 ===');
    
    // 1. 자동완성 활성화 여부
    console.log('✅ enableAutocomplete:', state.globalSettings?.enableAutocomplete);
    
    // 2. Autocomplete 모델 선택 확인
    const autocompleteModel = state.modelSelectionOfFeature?.['Autocomplete'];
    if (autocompleteModel) {
        console.log('✅ Autocomplete 모델:', {
            provider: autocompleteModel.providerName,
            model: autocompleteModel.modelName
        });
    } else {
        console.error('❌ Autocomplete 모델이 선택되지 않았습니다!');
        console.log('💡 해결방법: Void Settings > Feature Options > Autocomplete에서 모델을 선택하세요');
    }
    
    // 3. Chat 모델 확인 (참고용)
    const chatModel = state.modelSelectionOfFeature?.['Chat'];
    if (chatModel) {
        console.log('📝 Chat 모델 (참고):', {
            provider: chatModel.providerName,
            model: chatModel.modelName
        });
    }
    
    // 4. 자동완성 서비스 등록 확인
    const autocompleteService = accessor.get('AutocompleteService')?.[0];
    if (autocompleteService) {
        console.log('✅ Autocomplete Service 등록됨');
    } else {
        console.error('❌ Autocomplete Service가 등록되지 않았습니다');
    }
    
    // 5. 언어 기능 제공자 확인
    const langFeatures = accessor.get('ILanguageFeaturesService')?.[0];
    if (langFeatures) {
        const providers = langFeatures.inlineCompletionsProvider.all();
        console.log(`✅ 인라인 완성 제공자 수: ${providers.length}`);
    }
    
    console.log('=====================================');
    console.log('💡 자동완성 테스트: 코드 파일에서 타이핑 후 0.5초 기다려보세요');
})();