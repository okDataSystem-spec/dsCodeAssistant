/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { InlineCompletion, CompletionItemKind, CompletionTriggerKind } from '../../../../editor/common/languages.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { extractCodeFromRegular } from '../common/helpers/extractCodeFromResult.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { FeatureName } from '../common/voidSettingsTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITreeParserService } from './treeParserService.js';
// import { IContextGatheringService } from './contextGatheringService.js';



const allLinebreakSymbols = ['\r\n', '\n']
const _ln = isWindows ? allLinebreakSymbols[0] : allLinebreakSymbols[1]

// The extension this was called from is here - https://github.com/voideditor/void/blob/autocomplete/extensions/void/src/extension/extension.ts


/*
A summary of autotab:

Postprocessing
-one common problem for all models is outputting unbalanced parentheses
we solve this by trimming all extra closing parentheses from the generated string
in future, should make sure parentheses are always balanced

-another problem is completing the middle of a string, eg. "const [x, CURSOR] = useState()"
we complete up to first matchup character
but should instead complete the whole line / block (difficult because of parenthesis accuracy)

-too much info is bad. usually we want to show the user 1 line, and have a preloaded response afterwards
this should happen automatically with caching system
should break preloaded responses into \n\n chunks

Preprocessing
- we don't generate if cursor is at end / beginning of a line (no spaces)
- we generate 1 line if there is text to the right of cursor
- we generate 1 line if variable declaration
- (in many cases want to show 1 line but generate multiple)

State
- cache based on prefix (and do some trimming first)
- when press tab on one line, should have an immediate followup response
to do this, show autocompletes before they're fully finished
- [todo] remove each autotab when accepted
!- [todo] provide type information

Details
-generated results are trimmed up to 1 leading/trailing space
-prefixes are cached up to 1 trailing newline
-
*/

class LRUCache<K, V> {
	public items: Map<K, V>;
	private keyOrder: K[];
	private maxSize: number;
	private disposeCallback?: (value: V, key?: K) => void;

	constructor(maxSize: number, disposeCallback?: (value: V, key?: K) => void) {
		if (maxSize <= 0) throw new Error('Cache size must be greater than 0');

		this.items = new Map();
		this.keyOrder = [];
		this.maxSize = maxSize;
		this.disposeCallback = disposeCallback;
	}

	set(key: K, value: V): void {
		// If key exists, remove it from the order list
		if (this.items.has(key)) {
			this.keyOrder = this.keyOrder.filter(k => k !== key);
		}
		// If cache is full, remove least recently used item
		else if (this.items.size >= this.maxSize) {
			const key = this.keyOrder[0];
			const value = this.items.get(key);

			// Call dispose callback if it exists
			if (this.disposeCallback && value !== undefined) {
				this.disposeCallback(value, key);
			}

			this.items.delete(key);
			this.keyOrder.shift();
		}

		// Add new item
		this.items.set(key, value);
		this.keyOrder.push(key);
	}

	delete(key: K): boolean {
		const value = this.items.get(key);

		if (value !== undefined) {
			// Call dispose callback if it exists
			if (this.disposeCallback) {
				this.disposeCallback(value, key);
			}

			this.items.delete(key);
			this.keyOrder = this.keyOrder.filter(k => k !== key);
			return true;
		}

		return false;
	}

	clear(): void {
		// Call dispose callback for all items if it exists
		if (this.disposeCallback) {
			for (const [key, value] of this.items.entries()) {
				this.disposeCallback(value, key);
			}
		}

		this.items.clear();
		this.keyOrder = [];
	}

	get size(): number {
		return this.items.size;
	}

	has(key: K): boolean {
		return this.items.has(key);
	}
}

type AutocompletionPredictionType =
	| 'single-line-fill-middle'
	| 'single-line-redo-suffix'
	// | 'multi-line-start-here'
	| 'multi-line-start-on-next-line'
	| 'do-not-predict'

type Autocompletion = {
	id: number,
	prefix: string,
	suffix: string,
	llmPrefix: string,
	llmSuffix: string,
	startTime: number,
	endTime: number | undefined,
	status: 'pending' | 'finished' | 'error',
	type: AutocompletionPredictionType,
	llmPromise: Promise<string> | undefined,
	insertText: string,
	requestId: string | null,
	_newlineCount: number,
}

const DEBOUNCE_TIME = 500
const TIMEOUT_TIME = 60000
const MAX_CACHE_SIZE = 20
const MAX_PENDING_REQUESTS = 2

// postprocesses the result
const processStartAndEndSpaces = (result: string) => {

	// trim all whitespace except for a single leading/trailing space
	// return result.trim()

	[result,] = extractCodeFromRegular({ text: result, recentlyAddedTextLen: result.length })

	const hasLeadingSpace = result.startsWith(' ');
	const hasTrailingSpace = result.endsWith(' ');

	return (hasLeadingSpace ? ' ' : '')
		+ result.trim()
		+ (hasTrailingSpace ? ' ' : '');

}


// trims the end of the prefix to improve cache hit rate
const removeLeftTabsAndTrimEnds = (s: string): string => {
	const trimmedString = s.trimEnd();
	const trailingEnd = s.slice(trimmedString.length);

	// keep only a single trailing newline
	if (trailingEnd.includes(_ln)) {
		s = trimmedString + _ln;
	}

	s = s.replace(/^\s+/gm, ''); // remove left tabs

	return s;
}



const removeAllWhitespace = (str: string): string => str.replace(/\s+/g, '');



function getIsSubsequence({ of, subsequence }: { of: string, subsequence: string }): [boolean, string] {
	if (subsequence.length === 0) return [true, ''];
	if (of.length === 0) return [false, ''];

	let subsequenceIndex = 0;
	let lastMatchChar = '';

	for (let i = 0; i < of.length; i++) {
		if (of[i] === subsequence[subsequenceIndex]) {
			lastMatchChar = of[i];
			subsequenceIndex++;
		}
		if (subsequenceIndex === subsequence.length) {
			return [true, lastMatchChar];
		}
	}

	return [false, lastMatchChar];
}


function getStringUpToUnbalancedClosingParenthesis(s: string, prefix: string): string {

	const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };

	// process all bracets in prefix
	let stack: string[] = []
	const firstOpenIdx = prefix.search(/[[({]/);
	if (firstOpenIdx !== -1) {
		const brackets = prefix.slice(firstOpenIdx).split('').filter(c => '()[]{}'.includes(c));

		for (const bracket of brackets) {
			if (bracket === '(' || bracket === '{' || bracket === '[') {
				stack.push(bracket);
			} else {
				if (stack.length > 0 && stack[stack.length - 1] === pairs[bracket]) {
					stack.pop();
				} else {
					stack.push(bracket);
				}
			}
		}
	}

	// iterate through each character
	for (let i = 0; i < s.length; i++) {
		const char = s[i];

		if (char === '(' || char === '{' || char === '[') { stack.push(char); }
		else if (char === ')' || char === '}' || char === ']') {
			if (stack.length === 0 || stack.pop() !== pairs[char]) { return s.substring(0, i); }
		}
	}
	return s;
}


// further trim the autocompletion
const postprocessAutocompletion = ({ autocompletionMatchup, autocompletion, prefixAndSuffix }: { autocompletionMatchup: AutocompletionMatchupBounds, autocompletion: Autocompletion, prefixAndSuffix: PrefixAndSuffixInfo }) => {

	const { prefix, prefixToTheLeftOfCursor, suffixToTheRightOfCursor } = prefixAndSuffix

	const generatedMiddle = autocompletion.insertText

	let startIdx = autocompletionMatchup.startIdx
	let endIdx = generatedMiddle.length // exclusive bounds

	// const naiveReturnValue = generatedMiddle.slice(startIdx)
	// console.log('naiveReturnValue: ', JSON.stringify(naiveReturnValue))
	// return [{ insertText: naiveReturnValue, }]

	// do postprocessing for better ux
	// this is a bit hacky but may change a lot

	// if there is space at the start of the completion and user has added it, remove it
	const charToLeftOfCursor = prefixToTheLeftOfCursor.slice(-1)[0] || ''
	const userHasAddedASpace = charToLeftOfCursor === ' ' || charToLeftOfCursor === '\t'
	const rawFirstNonspaceIdx = generatedMiddle.slice(startIdx).search(/[^\t ]/)
	if (rawFirstNonspaceIdx > -1 && userHasAddedASpace) {
		const firstNonspaceIdx = rawFirstNonspaceIdx + startIdx;
		// console.log('p0', startIdx, rawFirstNonspaceIdx)
		startIdx = Math.max(startIdx, firstNonspaceIdx)
	}

	// if user is on a blank line and the generation starts with newline(s), remove them
	const numStartingNewlines = generatedMiddle.slice(startIdx).match(new RegExp(`^${_ln}+`))?.[0].length || 0;
	if (
		!prefixToTheLeftOfCursor.trim()
		&& !suffixToTheRightOfCursor.trim()
		&& numStartingNewlines > 0
	) {
		// console.log('p1', numStartingNewlines)
		startIdx += numStartingNewlines
	}

	// if the generated FIM text matches with the suffix on the current line, stop
	if (autocompletion.type === 'single-line-fill-middle' && suffixToTheRightOfCursor.trim()) { // completing in the middle of a line
		// complete until there is a match
		const rawMatchIndex = generatedMiddle.slice(startIdx).lastIndexOf(suffixToTheRightOfCursor.trim()[0])
		if (rawMatchIndex > -1) {
			// console.log('p2', rawMatchIndex, startIdx, suffixToTheRightOfCursor.trim()[0], 'AAA', generatedMiddle.slice(startIdx))
			const matchIdx = rawMatchIndex + startIdx;
			const matchChar = generatedMiddle[matchIdx]
			if (`{}()[]<>\`'"`.includes(matchChar)) {
				endIdx = Math.min(endIdx, matchIdx)
			}
		}
	}

	const restOfLineToGenerate = generatedMiddle.slice(startIdx).split(_ln)[0] ?? ''
	// condition to complete as a single line completion
	if (
		prefixToTheLeftOfCursor.trim()
		&& !suffixToTheRightOfCursor.trim()
		&& restOfLineToGenerate.trim()
	) {

		const rawNewlineIdx = generatedMiddle.slice(startIdx).indexOf(_ln)
		if (rawNewlineIdx > -1) {
			// console.log('p3', startIdx, rawNewlineIdx)
			const newlineIdx = rawNewlineIdx + startIdx;
			endIdx = Math.min(endIdx, newlineIdx)
		}
	}

	// // if a generated line matches with a suffix line, stop
	// if (suffixLines.length > 1) {
	// 	console.log('4')
	// 	const lines = []
	// 	for (const generatedLine of generatedLines) {
	// 		if (suffixLines.slice(0, 10).some(suffixLine =>
	// 			generatedLine.trim() !== '' && suffixLine.trim() !== ''
	// 			&& generatedLine.trim().startsWith(suffixLine.trim())
	// 		)) break;
	// 		lines.push(generatedLine)
	// 	}
	// 	endIdx = lines.join('\n').length // this is hacky, remove or refactor in future
	// }

	// console.log('pFinal', startIdx, endIdx)
	let completionStr = generatedMiddle.slice(startIdx, endIdx)

	// filter out unbalanced parentheses
	completionStr = getStringUpToUnbalancedClosingParenthesis(completionStr, prefix)
	// console.log('originalCompletionStr: ', JSON.stringify(generatedMiddle.slice(startIdx)))
	// console.log('finalCompletionStr: ', JSON.stringify(completionStr))


	return completionStr

}

// returns the text in the autocompletion to display, assuming the prefix is already matched
const toInlineCompletions = ({ autocompletionMatchup, autocompletion, prefixAndSuffix, position, debug }: { autocompletionMatchup: AutocompletionMatchupBounds, autocompletion: Autocompletion, prefixAndSuffix: PrefixAndSuffixInfo, position: Position, debug?: boolean }): { insertText: string, range: Range }[] => {

	let trimmedInsertText = postprocessAutocompletion({ autocompletionMatchup, autocompletion, prefixAndSuffix, })
	let rangeToReplace: Range = new Range(position.lineNumber, position.column, position.lineNumber, position.column)

	// handle special cases

	// if we redid the suffix, replace the suffix
	if (autocompletion.type === 'single-line-redo-suffix') {

		const oldSuffix = prefixAndSuffix.suffixToTheRightOfCursor
		const newSuffix = autocompletion.insertText

		const [isSubsequence, lastMatchingChar] = getIsSubsequence({ // check that the old text contains the same brackets + symbols as the new text
			subsequence: removeAllWhitespace(oldSuffix), // old suffix
			of: removeAllWhitespace(newSuffix), // new suffix
		})
		if (isSubsequence) {
			rangeToReplace = new Range(position.lineNumber, position.column, position.lineNumber, Number.MAX_SAFE_INTEGER)
		}
		else {

			const lastMatchupIdx = trimmedInsertText.lastIndexOf(lastMatchingChar)
			trimmedInsertText = trimmedInsertText.slice(0, lastMatchupIdx + 1)
			const numCharsToReplace = oldSuffix.lastIndexOf(lastMatchingChar) + 1
			rangeToReplace = new Range(position.lineNumber, position.column, position.lineNumber, position.column + numCharsToReplace)
			// console.log('show____', trimmedInsertText, rangeToReplace)
		}
	}

	return [{
		insertText: trimmedInsertText,
		range: rangeToReplace,
	}]

}





// returns whether this autocompletion is in the cache
// const doesPrefixMatchAutocompletion = ({ prefix, autocompletion }: { prefix: string, autocompletion: Autocompletion }): boolean => {

// 	const originalPrefix = autocompletion.prefix
// 	const generatedMiddle = autocompletion.result
// 	const originalPrefixTrimmed = trimPrefix(originalPrefix)
// 	const currentPrefixTrimmed = trimPrefix(prefix)

// 	if (currentPrefixTrimmed.length < originalPrefixTrimmed.length) {
// 		return false
// 	}

// 	const isMatch = (originalPrefixTrimmed + generatedMiddle).startsWith(currentPrefixTrimmed)
// 	return isMatch

// }


type PrefixAndSuffixInfo = { prefix: string, suffix: string, prefixLines: string[], suffixLines: string[], prefixToTheLeftOfCursor: string, suffixToTheRightOfCursor: string }
const getPrefixAndSuffixInfo = (model: ITextModel, position: Position): PrefixAndSuffixInfo => {

	const fullText = model.getValue(EndOfLinePreference.LF);

	const cursorOffset = model.getOffsetAt(position)
	const prefix = fullText.substring(0, cursorOffset)
	const suffix = fullText.substring(cursorOffset)


	const prefixLines = prefix.split(_ln)
	const suffixLines = suffix.split(_ln)

	const prefixToTheLeftOfCursor = prefixLines.slice(-1)[0] ?? ''
	const suffixToTheRightOfCursor = suffixLines[0] ?? ''

	return { prefix, suffix, prefixLines, suffixLines, prefixToTheLeftOfCursor, suffixToTheRightOfCursor }

}

const getIndex = (str: string, line: number, char: number) => {
	return str.split(_ln).slice(0, line).join(_ln).length + (line > 0 ? 1 : 0) + char;
}
const getLastLine = (s: string): string => {
	const matches = s.match(new RegExp(`[^${_ln}]*$`))
	return matches ? matches[0] : ''
}

type AutocompletionMatchupBounds = {
	startLine: number,
	startCharacter: number,
	startIdx: number,
}
// returns the startIdx of the match if there is a match, or undefined if there is no match
// all results are wrt `autocompletion.result`
const getAutocompletionMatchup = ({ prefix, autocompletion }: { prefix: string, autocompletion: Autocompletion }): AutocompletionMatchupBounds | undefined => {

	const trimmedCurrentPrefix = removeLeftTabsAndTrimEnds(prefix)
	const trimmedCompletionPrefix = removeLeftTabsAndTrimEnds(autocompletion.prefix)
	const trimmedCompletionMiddle = removeLeftTabsAndTrimEnds(autocompletion.insertText)

	// console.log('@result: ', JSON.stringify(autocompletion.insertText))
	// console.log('@trimmedCurrentPrefix: ', JSON.stringify(trimmedCurrentPrefix))
	// console.log('@trimmedCompletionPrefix: ', JSON.stringify(trimmedCompletionPrefix))
	// console.log('@trimmedCompletionMiddle: ', JSON.stringify(trimmedCompletionMiddle))

	if (trimmedCurrentPrefix.length < trimmedCompletionPrefix.length) { // user must write text beyond the original prefix at generation time
		// console.log('@undefined1')
		return undefined
	}

	if ( // check that completion starts with the prefix
		!(trimmedCompletionPrefix + trimmedCompletionMiddle)
			.startsWith(trimmedCurrentPrefix)
	) {
		// console.log('@undefined2')
		return undefined
	}

	// reverse map to find position wrt `autocompletion.result`
	const lineStart =
		trimmedCurrentPrefix.split(_ln).length -
		trimmedCompletionPrefix.split(_ln).length;

	if (lineStart < 0) {
		// console.log('@undefined3')

		console.error('Error: No line found.');
		return undefined;
	}
	const currentPrefixLine = getLastLine(trimmedCurrentPrefix)
	const completionPrefixLine = lineStart === 0 ? getLastLine(trimmedCompletionPrefix) : ''
	const completionMiddleLine = autocompletion.insertText.split(_ln)[lineStart]
	const fullCompletionLine = completionPrefixLine + completionMiddleLine

	// console.log('currentPrefixLine', currentPrefixLine)
	// console.log('completionPrefixLine', completionPrefixLine)
	// console.log('completionMiddleLine', completionMiddleLine)

	const charMatchIdx = fullCompletionLine.indexOf(currentPrefixLine)
	if (charMatchIdx < 0) {
		// console.log('@undefined4', charMatchIdx)

		console.error('Warning: Found character with negative index. This should never happen.')
		return undefined
	}

	const character = (charMatchIdx +
		currentPrefixLine.length
		- completionPrefixLine.length
	)

	const startIdx = getIndex(autocompletion.insertText, lineStart, character)

	return {
		startLine: lineStart,
		startCharacter: character,
		startIdx,
	}


}


type CompletionOptions = {
	predictionType: AutocompletionPredictionType,
	shouldGenerate: boolean,
	llmPrefix: string,
	llmSuffix: string,
	stopTokens: string[],
}
const getCompletionOptions = (prefixAndSuffix: PrefixAndSuffixInfo, relevantContext: string, justAcceptedAutocompletion: boolean): CompletionOptions => {

	let { prefix, suffix, prefixToTheLeftOfCursor, suffixToTheRightOfCursor, suffixLines, prefixLines } = prefixAndSuffix

	// trim prefix and suffix to not be very large
	suffixLines = suffix.split(_ln).slice(0, 25)
	prefixLines = prefix.split(_ln).slice(-25)
	prefix = prefixLines.join(_ln)
	suffix = suffixLines.join(_ln)

	let completionOptions: CompletionOptions

	// if line is empty, do multiline completion
	const isLineEmpty = !prefixToTheLeftOfCursor.trim() && !suffixToTheRightOfCursor.trim()
	const isLinePrefixEmpty = removeAllWhitespace(prefixToTheLeftOfCursor).length === 0
	const isLineSuffixEmpty = removeAllWhitespace(suffixToTheRightOfCursor).length === 0

	// TODO add context to prefix
	// llmPrefix = '\n\n/* Relevant context:\n' + relevantContext + '\n*/\n' + llmPrefix

	// if we just accepted an autocompletion, predict a multiline completion starting on the next line
	if (justAcceptedAutocompletion && isLineSuffixEmpty) {
		const prefixWithNewline = prefix + _ln
		completionOptions = {
			predictionType: 'multi-line-start-on-next-line',
			shouldGenerate: true,
			llmPrefix: prefixWithNewline,
			llmSuffix: suffix,
			stopTokens: [`${_ln}${_ln}`] // double newlines
		}
	}
	// if the current line is empty, predict a single-line completion
	else if (isLineEmpty) {
		completionOptions = {
			predictionType: 'single-line-fill-middle',
			shouldGenerate: true,
			llmPrefix: prefix,
			llmSuffix: suffix,
			stopTokens: allLinebreakSymbols
		}
	}
	// if suffix is 3 or fewer characters, attempt to complete the line ignorning it
	else if (removeAllWhitespace(suffixToTheRightOfCursor).length <= 3) {
		const suffixLinesIgnoringThisLine = suffixLines.slice(1)
		const suffixStringIgnoringThisLine = suffixLinesIgnoringThisLine.length === 0 ? '' : _ln + suffixLinesIgnoringThisLine.join(_ln)
		completionOptions = {
			predictionType: 'single-line-redo-suffix',
			shouldGenerate: true,
			llmPrefix: prefix,
			llmSuffix: suffixStringIgnoringThisLine,
			stopTokens: allLinebreakSymbols
		}
	}
	// else attempt to complete the middle of the line if there is a prefix (the completion looks bad if there is no prefix)
	else if (!isLinePrefixEmpty) {
		completionOptions = {
			predictionType: 'single-line-fill-middle',
			shouldGenerate: true,
			llmPrefix: prefix,
			llmSuffix: suffix,
			stopTokens: allLinebreakSymbols
		}
	} else {
		completionOptions = {
			predictionType: 'do-not-predict',
			shouldGenerate: false,
			llmPrefix: prefix,
			llmSuffix: suffix,
			stopTokens: []
		}
	}

	return completionOptions

}

export interface IAutocompleteService {
	readonly _serviceBrand: undefined;
}

export const IAutocompleteService = createDecorator<IAutocompleteService>('AutocompleteService');

export class AutocompleteService extends Disposable implements IAutocompleteService {

	static readonly ID = 'void.autocompleteService'

	_serviceBrand: undefined;

	private _autocompletionId: number = 0;
	private _autocompletionsOfDocument: { [docUriStr: string]: LRUCache<number, Autocompletion> } = {}

	private _lastCompletionStart = 0
	private _lastCompletionAccept = 0
	// private _lastPrefix: string = ''

	// used internally by vscode
	// fires after every keystroke and returns the completion to show
	async _provideInlineCompletionItems(
		model: ITextModel,
		position: Position,
	): Promise<InlineCompletion[]> {

		const isEnabled = this._settingsService.state.globalSettings.enableAutocomplete
		if (!isEnabled) return []

		const testMode = false

		const docUriStr = model.uri.fsPath;

		const prefixAndSuffix = getPrefixAndSuffixInfo(model, position)
		const { prefix, suffix } = prefixAndSuffix

		// initialize cache if it doesnt exist
		// note that whenever an autocompletion is accepted, it is removed from cache
		if (!this._autocompletionsOfDocument[docUriStr]) {
			this._autocompletionsOfDocument[docUriStr] = new LRUCache<number, Autocompletion>(
				MAX_CACHE_SIZE,
				(autocompletion: Autocompletion) => {
					if (autocompletion.requestId)
						this._llmMessageService.abort(autocompletion.requestId)
				}
			)
		}
		// this._lastPrefix = prefix

		// print all pending autocompletions
		// let _numPending = 0
		// this._autocompletionsOfDocument[docUriStr].items.forEach((a: Autocompletion) => { if (a.status === 'pending') _numPending += 1 })
		// console.log('@numPending: ' + _numPending)

		// get autocompletion from cache
		let cachedAutocompletion: Autocompletion | undefined = undefined
		let autocompletionMatchup: AutocompletionMatchupBounds | undefined = undefined
		for (const autocompletion of this._autocompletionsOfDocument[docUriStr].items.values()) {
			// if the user's change matches with the autocompletion
			autocompletionMatchup = getAutocompletionMatchup({ prefix, autocompletion })
			if (autocompletionMatchup !== undefined) {
				cachedAutocompletion = autocompletion
				break;
			}
		}

		// if there is a cached autocompletion, return it
		if (cachedAutocompletion && autocompletionMatchup) {

			console.log('AA')


			// console.log('id: ' + cachedAutocompletion.id)

			if (cachedAutocompletion.status === 'finished') {
				console.log('A1')

				const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: cachedAutocompletion, prefixAndSuffix, position, debug: true })
				return inlineCompletions

			} else if (cachedAutocompletion.status === 'pending') {
				console.log('A2')

				try {
					await cachedAutocompletion.llmPromise;
					const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: cachedAutocompletion, prefixAndSuffix, position })
					return inlineCompletions

				} catch (e) {
					this._autocompletionsOfDocument[docUriStr].delete(cachedAutocompletion.id)
					console.error('Error creating autocompletion (1): ' + e)
				}

			} else if (cachedAutocompletion.status === 'error') {
				console.log('A3')
			} else {
				console.log('A4')
			}

			return []
		}

		// else if no more typing happens, then go forwards with the request

		// wait DEBOUNCE_TIME for the user to stop typing
		const thisTime = Date.now()

		const justAcceptedAutocompletion = thisTime - this._lastCompletionAccept < 500

		this._lastCompletionStart = thisTime
		const didTypingHappenDuringDebounce = await new Promise((resolve, reject) =>
			setTimeout(() => {
				if (this._lastCompletionStart === thisTime) {
					resolve(false)
				} else {
					resolve(true)
				}
			}, DEBOUNCE_TIME)
		)

		// if more typing happened, then do not go forwards with the request
		if (didTypingHappenDuringDebounce) {
			return []
		}


		// if there are too many pending requests, cancel the oldest one
		let numPending = 0
		let oldestPending: Autocompletion | undefined = undefined
		for (const autocompletion of this._autocompletionsOfDocument[docUriStr].items.values()) {
			if (autocompletion.status === 'pending') {
				numPending += 1
				if (oldestPending === undefined) {
					oldestPending = autocompletion
				}
				if (numPending >= MAX_PENDING_REQUESTS) {
					// cancel the oldest pending request and remove it from cache
					this._autocompletionsOfDocument[docUriStr].delete(oldestPending.id)
					break
				}
			}
		}


		// gather relevant context from the code around the user's selection and definitions
		// const relevantSnippetsList = await this._contextGatheringService.readCachedSnippets(model, position, 3);
		// const relevantSnippetsList = this._contextGatheringService.getCachedSnippets();
		// const relevantSnippets = relevantSnippetsList.map((text) => `${text}`).join('\n-------------------------------\n')
		// console.log('@@---------------------\n' + relevantSnippets)
		
		// LSP를 활용한 향상된 컨텍스트 수집
		const lspContext = await this.gatherLSPContext(model, position);
		console.log('OKDS LSP>> 컨텍스트 수집 완료:', lspContext);
		
		const relevantContext = lspContext

		let { shouldGenerate, predictionType, llmPrefix, llmSuffix, stopTokens } = getCompletionOptions(prefixAndSuffix, relevantContext, justAcceptedAutocompletion);
		
		// LSP 컨텍스트를 프롬프트에 추가
		if (lspContext && lspContext.length > 0) {
			// 컨텍스트를 프롬프트 앞에 추가
			const contextPrompt = `/* Context Information:
${lspContext}
*/

`;
			llmPrefix = contextPrompt + llmPrefix;
			console.log('OKDS LSP>> 프롬프트에 컨텍스트 추가됨');
			
			// 최종 프롬프트 로깅 - 전체 내용 표시
			console.log('OKDS FINAL>> ===== 최종 LLM 프롬프트 =====');
			console.log('OKDS FINAL>> [PREDICTION TYPE]:', predictionType);
			console.log('OKDS FINAL>> --- PREFIX 시작 (총 ' + llmPrefix.length + '자) ---');
			console.log(llmPrefix);
			console.log('OKDS FINAL>> --- PREFIX 끝 ---');
			console.log('OKDS FINAL>> --- SUFFIX 시작 (총 ' + llmSuffix.length + '자) ---');
			console.log(llmSuffix);
			console.log('OKDS FINAL>> --- SUFFIX 끝 ---');
			console.log('OKDS FINAL>> ================================');
		}

		if (!shouldGenerate) return []

		if (testMode && this._autocompletionId !== 0) { // TODO remove this
			return []
		}



		// create a new autocompletion and add it to cache
		const newAutocompletion: Autocompletion = {
			id: this._autocompletionId++,
			prefix: prefix, // the actual prefix and suffix
			suffix: suffix,
			llmPrefix: llmPrefix, // the prefix and suffix the llm sees
			llmSuffix: llmSuffix,
			startTime: Date.now(),
			endTime: undefined,
			type: predictionType,
			status: 'pending',
			llmPromise: undefined,
			insertText: '',
			requestId: null,
			_newlineCount: 0,
		}

		console.log('starting autocomplete...', predictionType)

		const featureName: FeatureName = 'Autocomplete'
		const overridesOfModel = this._settingsService.state.overridesOfModel
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined

		// set parameters of `newAutocompletion` appropriately
		newAutocompletion.llmPromise = new Promise((resolve, reject) => {

			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'FIMMessage',
				messages: this._convertToLLMMessageService.prepareFIMMessage({
					messages: {
						prefix: llmPrefix,
						suffix: llmSuffix,
						stopTokens: stopTokens,
					}
				}),
				modelSelection,
				modelSelectionOptions,
				overridesOfModel,
				logging: { loggingName: 'Autocomplete' },
				onText: () => { }, // unused in FIMMessage
				// onText: async ({ fullText, newText }) => {

				// 	newAutocompletion.insertText = fullText

				// 	// count newlines in newText
				// 	const numNewlines = newText.match(/\n|\r\n/g)?.length || 0
				// 	newAutocompletion._newlineCount += numNewlines

				// 	// if too many newlines, resolve up to last newline
				// 	if (newAutocompletion._newlineCount > 10) {
				// 		const lastNewlinePos = fullText.lastIndexOf('\n')
				// 		newAutocompletion.insertText = fullText.substring(0, lastNewlinePos)
				// 		resolve(newAutocompletion.insertText)
				// 		return
				// 	}

				// 	// if (!getAutocompletionMatchup({ prefix: this._lastPrefix, autocompletion: newAutocompletion })) {
				// 	// 	reject('LLM response did not match user\'s text.')
				// 	// }
				// },
				onFinalMessage: ({ fullText }) => {

					// console.log('____res: ', JSON.stringify(newAutocompletion.insertText))

					newAutocompletion.endTime = Date.now()
					newAutocompletion.status = 'finished'
					const [text, _] = extractCodeFromRegular({ text: fullText, recentlyAddedTextLen: 0 })
					newAutocompletion.insertText = processStartAndEndSpaces(text)

					// handle special case for predicting starting on the next line, add a newline character
					if (newAutocompletion.type === 'multi-line-start-on-next-line') {
						newAutocompletion.insertText = _ln + newAutocompletion.insertText
					}

					resolve(newAutocompletion.insertText)

				},
				onError: ({ message }) => {
					newAutocompletion.endTime = Date.now()
					newAutocompletion.status = 'error'
					reject(message)
				},
				onAbort: () => { reject('Aborted autocomplete') },
			})
			newAutocompletion.requestId = requestId

			// if the request hasnt resolved in TIMEOUT_TIME seconds, reject it
			setTimeout(() => {
				if (newAutocompletion.status === 'pending') {
					reject('Timeout receiving message to LLM.')
				}
			}, TIMEOUT_TIME)

		})



		// add autocompletion to cache
		this._autocompletionsOfDocument[docUriStr].set(newAutocompletion.id, newAutocompletion)

		// show autocompletion
		try {
			await newAutocompletion.llmPromise
			// console.log('id: ' + newAutocompletion.id)

			const autocompletionMatchup: AutocompletionMatchupBounds = { startIdx: 0, startLine: 0, startCharacter: 0 }
			const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: newAutocompletion, prefixAndSuffix, position })
			return inlineCompletions

		} catch (e) {
			this._autocompletionsOfDocument[docUriStr].delete(newAutocompletion.id)
			console.error('Error creating autocompletion (2): ' + e)
			return []
		}

	}

	constructor(
		@ILanguageFeaturesService private _langFeatureService: ILanguageFeaturesService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessageService: IConvertToLLMMessageService,
		@ITreeParserService private readonly _treeParserService: ITreeParserService
		// @IContextGatheringService private readonly _contextGatheringService: IContextGatheringService,
	) {
		super()

		this._register(this._langFeatureService.inlineCompletionsProvider.register('*', {
			provideInlineCompletions: async (model, position, context, token) => {
				const items = await this._provideInlineCompletionItems(model, position)

				// console.log('item: ', items?.[0]?.insertText)
				return { items: items, }
			},
			freeInlineCompletions: (completions) => {
				// get the `docUriStr` and the `position` of the cursor
				const activePane = this._editorService.activeEditorPane;
				if (!activePane) return;
				const control = activePane.getControl();
				if (!control || !isCodeEditor(control)) return;
				const position = control.getPosition();
				if (!position) return;
				const resource = EditorResourceAccessor.getCanonicalUri(this._editorService.activeEditor);
				if (!resource) return;
				const model = this._modelService.getModel(resource)
				if (!model) return;
				const docUriStr = resource.fsPath;
				if (!this._autocompletionsOfDocument[docUriStr]) return;

				const { prefix, } = getPrefixAndSuffixInfo(model, position)

				// go through cached items and remove matching ones
				// autocompletion.prefix + autocompletion.insertedText ~== insertedText
				this._autocompletionsOfDocument[docUriStr].items.forEach((autocompletion: Autocompletion) => {

					// we can do this more efficiently, I just didn't want to deal with all of the edge cases
					const matchup = removeAllWhitespace(prefix) === removeAllWhitespace(autocompletion.prefix + autocompletion.insertText)

					if (matchup) {
						console.log('ACCEPT', autocompletion.id)
						this._lastCompletionAccept = Date.now()
						this._autocompletionsOfDocument[docUriStr].delete(autocompletion.id);
					}
				});

			},
		}))
	}

	// LSP와 Tree-sitter를 활용한 향상된 컨텍스트 수집
	private async gatherLSPContext(model: ITextModel, position: Position): Promise<string> {
		console.log('OKDS LSP>> 컨텍스트 수집 시작');
		const contextParts: string[] = [];
		
		try {
			// 현재 라인과 커서 위치 정보
			const currentLine = model.getLineContent(position.lineNumber);
			const textBeforeCursor = currentLine.substring(0, position.column - 1);
			const lines = model.getValue().split('\n');
			
			// 점(.) 연산자를 사용 중인지 확인
			const isDotAccess = textBeforeCursor.includes('.');
			const lastDotIndex = textBeforeCursor.lastIndexOf('.');
			let objectName = '';
			
			if (isDotAccess && lastDotIndex > 0) {
				// 점 앞의 객체명 추출
				const beforeDot = textBeforeCursor.substring(0, lastDotIndex);
				const objMatch = beforeDot.match(/(\w+)\s*$/);
				if (objMatch) {
					objectName = objMatch[1];
					contextParts.push(`Accessing object: ${objectName}`);
					console.log('OKDS LSP>> 객체 접근:', objectName);
					
					// 객체의 타입 찾기
					for (let i = position.lineNumber - 2; i >= Math.max(0, position.lineNumber - 50); i--) {
						const line = lines[i];
						// Java 변수 선언 패턴
						const varDeclPattern = new RegExp(`(\\w+(?:<[^>]+>)?)\\s+${objectName}\\s*=`);
						const match = line.match(varDeclPattern);
						if (match) {
							const objectType = match[1];
							contextParts.push(`${objectName} is type: ${objectType}`);
							// VO/DTO인 경우 특별 표시
							if (objectType.match(/VO$|DTO$|Model$|Entity$/)) {
								contextParts.push(`${objectType} has getter/setter methods for its fields`);
							}
							console.log('OKDS LSP>> 객체 타입:', objectType);
							break;
						}
					}
				}
			}
			
			// 1. Hover Provider로 타입 정보 가져오기
			const hoverInfo = await this.getHoverInfo(model, position);
			if (hoverInfo) {
				contextParts.push(hoverInfo);
				console.log('OKDS LSP>> Hover 정보 수집됨');
			}
			
			// 2. 향상된 Completion Provider로 메소드 목록
			const completions = await this.getEnhancedCompletions(model, position, isDotAccess);
			if (completions.length > 0) {
				contextParts.push(...completions);
				console.log('OKDS LSP>> 사용 가능한 완성 목록:', completions.length, '개');
			}
			
			// 3. Definition Provider로 정의 위치 찾기
			const definitions = await this.getDefinitions(model, position);
			if (definitions) {
				contextParts.push(`Definitions: ${definitions}`);
				console.log('OKDS LSP>> 정의 위치:', definitions);
			}
			
			// 4. 최근 변수 선언 찾기
			const recentVariables = this.findRecentVariables(lines, position.lineNumber);
			if (recentVariables.length > 0) {
				contextParts.push('Recent variables:');
				contextParts.push(...recentVariables);
				console.log('OKDS LSP>> 최근 변수:', recentVariables.length, '개');
			}
			
			// 5. Tree-sitter로 메소드 컨텍스트 분석
			const methodContext = await this._treeParserService.getMethodContext(model, position);
			if (methodContext) {
				contextParts.push(`Current method: ${methodContext.methodName}`);
				
				if (methodContext.parameters.length > 0) {
					const params = methodContext.parameters.map(p => `${p.type} ${p.name}`).join(', ');
					contextParts.push(`Method parameters: ${params}`);
				}
				
				if (methodContext.localVariables.length > 0) {
					const localVars = methodContext.localVariables.map(v => `${v.type} ${v.name}`).join(', ');
					contextParts.push(`Local variables: ${localVars}`);
				}
				
				if (methodContext.returnType) {
					contextParts.push(`Return type: ${methodContext.returnType}`);
				}
				
				console.log('OKDS Tree>> 메소드 컨텍스트 수집 완료');
			}
			
		} catch (error) {
			console.error('OKDS LSP>> 컨텍스트 수집 오류:', error);
		}
		
		const finalContext = contextParts.join('\n');
		console.log('OKDS LSP>> === 최종 수집된 컨텍스트 ===');
		console.log(finalContext);
		console.log('OKDS LSP>> ==============================');
		
		return finalContext;
	}
	
	// Hover 정보 가져오기
	private async getHoverInfo(model: ITextModel, position: Position): Promise<string | null> {
		const providers = this._langFeatureService.hoverProvider.ordered(model);
		
		for (const provider of providers) {
			try {
				const hover = await provider.provideHover(model, position, CancellationToken.None);
				if (hover?.contents) {
					// contents를 문자열로 변환
					const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
					const textContent = contents.map(c => {
						if (typeof c === 'string') return c;
						if ('value' in c) return c.value;
						return '';
					}).filter(s => s).join('\n');
					
					if (textContent) {
						return textContent;
					}
				}
			} catch (e) {
				console.error('OKDS LSP>> Hover provider 오류:', e);
			}
		}
		return null;
	}
	
	// Completion 정보 가져오기 (개선된 버전)
	private async _getCompletions(model: ITextModel, position: Position): Promise<string[]> {
		const providers = this._langFeatureService.completionProvider.ordered(model);
		const completions: string[] = [];
		
		// 현재 줄 분석하여 변수명 추출
		const currentLine = model.getLineContent(position.lineNumber);
		const beforeCursor = currentLine.substring(0, position.column - 1);
		const isMethodCall = beforeCursor.includes('.');
		
		console.log('OKDS LSP>> Completion 수집, 메소드 호출:', isMethodCall);
		
		for (const provider of providers) {
			try {
				const suggestions = await provider.provideCompletionItems(
					model,
					position,
					{} as any,
					CancellationToken.None
				);
				
				if (suggestions?.suggestions) {
					// 메소드 호출인 경우 메소드만 필터링
					const filtered = isMethodCall ? 
						suggestions.suggestions.filter(s => {
							// CompletionItemKind.Method = 0, Function = 1
							return s.kind === 0 || s.kind === 1 || s.kind === 2; // Method, Function, Constructor
						}) : suggestions.suggestions;
					
					filtered.forEach(s => {
						const label = typeof s.label === 'string' ? s.label : s.label.label;
						const detail = s.detail || '';
						// const doc = typeof s.documentation === 'string' ? s.documentation : '';
						
						// 더 자세한 정보 포함
						if (detail && detail.includes('(')) {
							// 메소드 시그니처가 있는 경우
							completions.push(`${label}${detail}`);
						} else if (detail) {
							completions.push(`${label}:${detail}`);
						} else {
							completions.push(label);
						}
					});
				}
			} catch (e) {
				console.error('OKDS LSP>> Completion provider 오류:', e);
			}
		}
		
		console.log('OKDS LSP>> 필터링된 완성 항목:', completions.slice(0, 5));
		return completions;
	}
	
	// Definition 정보 가져오기
	private async getDefinitions(model: ITextModel, position: Position): Promise<string | null> {
		const providers = this._langFeatureService.definitionProvider.ordered(model);
		
		for (const provider of providers) {
			try {
				const definitions = await provider.provideDefinition(
					model,
					position,
					CancellationToken.None
				);
				
				if (definitions) {
					const defs = Array.isArray(definitions) ? definitions : [definitions];
					const defInfo = defs.map(d => {
						return `${d.uri.fsPath}:${d.range.startLineNumber}`;
					}).join(', ');
					
					if (defInfo) {
						return defInfo;
					}
				}
			} catch (e) {
				console.error('OKDS LSP>> Definition provider 오류:', e);
			}
		}
		return null;
	}
	
	// 향상된 Completion 정보 가져오기
	private async getEnhancedCompletions(model: ITextModel, position: Position, isDotAccess: boolean): Promise<string[]> {
		const completionInfo: string[] = [];
		try {
			const providers = this._langFeatureService.completionProvider.ordered(model);
			
			for (const provider of providers) {
				const result = await provider.provideCompletionItems(
					model,
					position,
					{ triggerKind: CompletionTriggerKind.Invoke, triggerCharacter: isDotAccess ? '.' : undefined },
					CancellationToken.None
				);
				
				if (result?.suggestions) {
					// getter/setter 메소드 우선 필터링
					const getterSetters = result.suggestions
						.filter(s => {
							const label = typeof s.label === 'string' ? s.label : s.label.label;
							return label.startsWith('get') || label.startsWith('set');
						})
						.slice(0, 10);
					
					if (getterSetters.length > 0) {
						completionInfo.push('Available getters/setters:');
						for (const item of getterSetters) {
							const label = typeof item.label === 'string' ? item.label : item.label.label;
							const detail = item.detail || '';
							if (detail) {
								completionInfo.push(`  - ${label}: ${detail}`);
							} else {
								completionInfo.push(`  - ${label}()`);
							}
						}
					}
					
					// 일반 메소드
					const methods = result.suggestions
						.filter(s => {
							const label = typeof s.label === 'string' ? s.label : s.label.label;
							return (s.kind === CompletionItemKind.Method || 
									s.kind === CompletionItemKind.Function) &&
								   !label.startsWith('get') && !label.startsWith('set');
						})
						.slice(0, 5);
					
					if (methods.length > 0) {
						completionInfo.push('Other methods:');
						for (const item of methods) {
							const label = typeof item.label === 'string' ? item.label : item.label.label;
							const detail = item.detail || '';
							completionInfo.push(`  - ${label}${detail ? ': ' + detail : ''}`);
						}
					}
				}
			}
		} catch (e) {
			console.error('OKDS LSP>> Completion provider 오류:', e);
		}
		
		return completionInfo;
	}
	
	// 최근 변수 선언 찾기
	private findRecentVariables(lines: string[], currentLine: number): string[] {
		const variables: string[] = [];
		const startLine = Math.max(0, currentLine - 20);
		
		for (let i = currentLine - 1; i >= startLine; i--) {
			const line = lines[i];
			
			// Java 변수 선언 패턴
			const javaPattern = /^\s*(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*=/;
			const javaMatch = line.match(javaPattern);
			if (javaMatch) {
				const varType = javaMatch[1];
				const varName = javaMatch[2];
				
				// VO/DTO 클래스인지 체크
				if (varType.match(/VO$|DTO$|Model$|Entity$/)) {
					variables.push(`  - ${varName}: ${varType} (has getters/setters)`);
				} else {
					variables.push(`  - ${varName}: ${varType}`);
				}
			}
			
			// TypeScript/JavaScript 변수 선언
			const tsPattern = /^\s*(?:const|let|var)\s+(\w+)(?:\s*:\s*(\w+(?:<[^>]+>)?))?.*=/;
			const tsMatch = line.match(tsPattern);
			if (tsMatch) {
				variables.push(`  - ${tsMatch[1]}: ${tsMatch[2] || 'any'}`);
			}
			
			// 최대 10개까지만
			if (variables.length >= 10) break;
		}
		
		return variables;
	}
	
	// 변수 타입 추출 (간단한 패턴 매칭)
	private _extractVariableType(model: ITextModel, position: Position, currentLine: string): string | null {
		// 현재 줄에서 변수명 추출
		const beforeCursor = currentLine.substring(0, position.column - 1);
		const varMatch = beforeCursor.match(/(\w+)\s*\.?\s*$/);
		
		if (varMatch) {
			const varName = varMatch[1];
			
			// 위로 스캔하면서 변수 선언 찾기
			for (let i = position.lineNumber - 1; i >= Math.max(0, position.lineNumber - 50); i--) {
				const line = model.getLineContent(i + 1); // lineNumber는 1-based
				
				// Java/TypeScript 변수 선언 패턴
				const patterns = [
					new RegExp(`(\\w+(?:<[^>]+>)?)\\s+${varName}\\s*[=;]`), // Type varName
					new RegExp(`const\\s+${varName}\\s*:\\s*(\\w+(?:<[^>]+>)?)`), // const varName: Type
					new RegExp(`let\\s+${varName}\\s*:\\s*(\\w+(?:<[^>]+>)?)`), // let varName: Type
					new RegExp(`var\\s+${varName}\\s*:\\s*(\\w+(?:<[^>]+>)?)`) // var varName: Type
				];
				
				for (const pattern of patterns) {
					const match = line.match(pattern);
					if (match) {
						return match[1];
					}
				}
			}
		}
		
		return null;
	}

}

registerWorkbenchContribution2(AutocompleteService.ID, AutocompleteService, WorkbenchPhase.BlockRestore);


