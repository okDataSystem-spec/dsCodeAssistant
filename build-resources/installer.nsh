; OKDS AI Assistant NSIS 추가 설정
; 한글 지원 및 커스터마이징

!macro preInit
  ; 한글 코드 페이지 설정
  System::Call 'kernel32::SetConsoleOutputCP(i 65001)'
  
  ; 관리자 권한 확인
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 != "admin"
    MessageBox MB_ICONEXCLAMATION "관리자 권한이 필요합니다.$\n관리자 권한으로 다시 실행해 주세요."
    SetErrorLevel 740
    Quit
  ${EndIf}
!macroend

!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "OKDS AI Assistant 설치"
  !define MUI_WELCOMEPAGE_TEXT "OKDS AI Assistant를 설치합니다.$\r$\n$\r$\n이 프로그램은 AI 기반 코드 어시스턴트입니다.$\r$\n$\r$\n설치를 계속하려면 다음을 클릭하세요."
  !define MUI_FINISHPAGE_TITLE "OKDS AI Assistant 설치 완료"
  !define MUI_FINISHPAGE_TEXT "OKDS AI Assistant가 성공적으로 설치되었습니다."
  !define MUI_FINISHPAGE_RUN "$INSTDIR\OKDS AI Assistant.exe"
  !define MUI_FINISHPAGE_RUN_TEXT "OKDS AI Assistant 실행"
!macroend

!macro customInstall
  ; 한글 폰트 설정
  SetRegView 64
  
  ; 바탕화면 바로가기 생성
  CreateShortcut "$DESKTOP\OKDS AI Assistant.lnk" "$INSTDIR\OKDS AI Assistant.exe" "" "$INSTDIR\resources\win32\code.ico"
  
  ; 시작 메뉴 바로가기 생성
  CreateDirectory "$SMPROGRAMS\OKDS AI Assistant"
  CreateShortcut "$SMPROGRAMS\OKDS AI Assistant\OKDS AI Assistant.lnk" "$INSTDIR\OKDS AI Assistant.exe" "" "$INSTDIR\resources\win32\code.ico"
  CreateShortcut "$SMPROGRAMS\OKDS AI Assistant\제거.lnk" "$INSTDIR\Uninstall OKDS AI Assistant.exe"
  
  ; 파일 연결 설정
  WriteRegStr HKCR ".js" "" "OKDSAIAssistant.js"
  WriteRegStr HKCR "OKDSAIAssistant.js" "" "JavaScript File"
  WriteRegStr HKCR "OKDSAIAssistant.js\DefaultIcon" "" "$INSTDIR\resources\win32\javascript.ico,0"
  WriteRegStr HKCR "OKDSAIAssistant.js\shell\open\command" "" '"$INSTDIR\OKDS AI Assistant.exe" "%1"'
  
  ; PATH 환경 변수 추가 (선택적)
  ; ${EnvVarUpdate} $0 "PATH" "A" "HKLM" "$INSTDIR\bin"
!macroend

!macro customUnInstall
  ; 바로가기 제거
  Delete "$DESKTOP\OKDS AI Assistant.lnk"
  RMDir /r "$SMPROGRAMS\OKDS AI Assistant"
  
  ; 레지스트리 정리
  DeleteRegKey HKCR "OKDSAIAssistant.js"
  
  ; 사용자 데이터 보존 여부 확인
  MessageBox MB_YESNO "사용자 설정과 데이터를 삭제하시겠습니까?" IDYES deleteUserData IDNO keepUserData
  deleteUserData:
    RMDir /r "$APPDATA\OKDS AI Assistant"
  keepUserData:
!macroend

; 한글 메시지 정의
LangString MUI_TEXT_WELCOME_INFO_TITLE ${LANG_KOREAN} "OKDS AI Assistant 설치를 시작합니다"
LangString MUI_TEXT_WELCOME_INFO_TEXT ${LANG_KOREAN} "이 프로그램은 OKDS AI Assistant를 컴퓨터에 설치합니다.$\r$\n$\r$\n설치하기 전에 다른 모든 프로그램을 종료하는 것이 좋습니다.$\r$\n$\r$\n계속하려면 다음을 클릭하세요."
LangString MUI_TEXT_DIRECTORY_TITLE ${LANG_KOREAN} "설치 위치 선택"
LangString MUI_TEXT_DIRECTORY_SUBTITLE ${LANG_KOREAN} "OKDS AI Assistant를 설치할 폴더를 선택하세요."
LangString MUI_TEXT_INSTALLING_TITLE ${LANG_KOREAN} "설치 중"
LangString MUI_TEXT_INSTALLING_SUBTITLE ${LANG_KOREAN} "OKDS AI Assistant를 설치하는 중입니다. 잠시 기다려주세요."
LangString MUI_TEXT_FINISH_TITLE ${LANG_KOREAN} "설치 완료"
LangString MUI_TEXT_FINISH_SUBTITLE ${LANG_KOREAN} "OKDS AI Assistant가 성공적으로 설치되었습니다."