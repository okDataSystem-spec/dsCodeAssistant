// Dify 프로바이더 시스템 메시지 테스트용 런타임 패치
// 브라우저 콘솔에서 실행하여 수정 사항 테스트

console.log('=== Dify 시스템 메시지 패치 테스트 ===');

// sendDifyChat 함수 오버라이드
if (window.sendDifyChat) {
    const originalSendDifyChat = window.sendDifyChat;
    
    window.sendDifyChat = function({ messages, separateSystemMessage, onText, onFinalMessage, onError, settingsOfProvider, providerName }) {
        console.log('📝 Dify Chat 호출됨:');
        console.log('- separateSystemMessage:', separateSystemMessage?.substring(0, 100) + '...');
        console.log('- messages:', messages);
        
        // 수정된 로직 테스트
        const difyMessages = [];
        
        // Add system message if present
        if (separateSystemMessage) {
            difyMessages.push({
                role: 'system',
                content: separateSystemMessage
            });
        }
        
        // Convert conversation messages
        for (const msg of messages) {
            if ('content' in msg && typeof msg.content === 'string') {
                difyMessages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: msg.content
                });
            }
        }
        
        // Get the last user message as query
        const lastUserMessage = difyMessages.filter(m => m.role === 'user').pop();
        const query = lastUserMessage?.content || 'Hello';
        
        // 🔥 수정된 부분: 시스템 메시지와 query 결합
        const full_query = separateSystemMessage ? `${separateSystemMessage}\n\n${query}` : query;
        
        console.log('🚀 최종 전송될 query:');
        console.log('- 원본 query:', query);
        console.log('- 결합된 full_query:', full_query.substring(0, 200) + '...');
        
        // 원본 함수 호출 (실제로는 수정된 로직으로 동작해야 함)
        return originalSendDifyChat.apply(this, arguments);
    };
    
    console.log('✅ Dify 패치 적용 완료');
} else {
    console.log('❌ sendDifyChat 함수를 찾을 수 없음');
}

// 테스트용 함수
window.testDifySystemMessage = function() {
    console.log('🧪 Dify 시스템 메시지 테스트 시작');
    
    const testSystemMessage = `당신은 도움이 되는 AI 어시스턴트입니다.
현재 작업 디렉토리: /home/okds/Desktop/dsCodeAssistant
주요 파일들:
- src/: 소스 코드
- okds/: 커스터마이징 파일
- scripts/: 실행 스크립트`;
    
    const testMessages = [
        { role: 'user', content: '안녕하세요' }
    ];
    
    if (window.sendDifyChat) {
        window.sendDifyChat({
            messages: testMessages,
            separateSystemMessage: testSystemMessage,
            onText: (result) => console.log('📥 응답:', result),
            onFinalMessage: (result) => console.log('✅ 완료:', result),
            onError: (error) => console.error('❌ 에러:', error),
            settingsOfProvider: { dify: { apiKey: 'test', endpoint: 'test' } },
            providerName: 'dify'
        });
    }
};

console.log('💡 testDifySystemMessage() 함수를 호출해서 테스트할 수 있습니다.');