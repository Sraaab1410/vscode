/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from 'vs/base/common/codicons';
import { ThemeIcon } from 'vs/base/common/themables';
import { IActiveCodeEditor, ICodeEditor, IEditorMouseEvent } from 'vs/editor/browser/editorBrowser';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { GlyphMarginLane, IModelDecorationOptions, IModelDecorationsChangeAccessor, TrackedRangeStickiness } from 'vs/editor/common/model';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { localize } from 'vs/nls';
import { registerIcon } from 'vs/platform/theme/common/iconRegistry';
import { InlineChatController } from 'vs/workbench/contrib/inlineChat/browser/inlineChatController';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { DisposableStore, Disposable } from 'vs/base/common/lifecycle';
import { GutterActionsRegistry } from 'vs/workbench/contrib/codeEditor/browser/editorLineNumberMenu';
import { Action } from 'vs/base/common/actions';
import { IInlineChatService, ShowGutterIcon } from 'vs/workbench/contrib/inlineChat/common/inlineChat';
import { RunOnceScheduler } from 'vs/base/common/async';
import { Iterable } from 'vs/base/common/iterator';
import { Range } from 'vs/editor/common/core/range';
import { IInlineChatSessionService } from 'vs/workbench/contrib/inlineChat/browser/inlineChatSession';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { LOCALIZED_START_INLINE_CHAT_STRING } from 'vs/workbench/contrib/inlineChat/browser/inlineChatActions';
import { IDebugService } from 'vs/workbench/contrib/debug/common/debug';
import { IPreferencesService } from 'vs/workbench/services/preferences/common/preferences';

const GUTTER_INLINE_CHAT_OPAQUE_ICON = registerIcon('inline-chat-opaque', Codicon.sparkle, localize('startInlineChatOpaqueIcon', 'Icon which spawns the inline chat from the gutter. It is half opaque by default and becomes completely opaque on hover.'));
const GUTTER_INLINE_CHAT_TRANSPARENT_ICON = registerIcon('inline-chat-transparent', Codicon.sparkle, localize('startInlineChatTransparentIcon', 'Icon which spawns the inline chat from the gutter. It is transparent by default and becomes opaque on hover.'));

export class InlineChatDecorationsContribution extends Disposable implements IEditorContribution {

	private _gutterDecorationID: string | undefined;
	private _inlineChatKeybinding: string | undefined;
	private readonly _localToDispose = new DisposableStore();
	private readonly _gutterDecorationOpaque: IModelDecorationOptions;
	private readonly _gutterDecorationTransparent: IModelDecorationOptions;

	public static readonly GUTTER_SETTING_ID = 'inlineChat.showGutterIcon';
	private static readonly GUTTER_ICON_OPAQUE_CLASSNAME = 'codicon-inline-chat-opaque';
	private static readonly GUTTER_ICON_TRANSPARENT_CLASSNAME = 'codicon-inline-chat-transparent';

	constructor(
		private readonly _editor: ICodeEditor,
		@IInlineChatService private readonly _inlineChatService: IInlineChatService,
		@IInlineChatSessionService private readonly _inlineChatSessionService: IInlineChatSessionService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IDebugService private readonly _debugService: IDebugService
	) {
		super();
		this._gutterDecorationTransparent = this._registerGutterDecoration(true);
		this._gutterDecorationOpaque = this._registerGutterDecoration(false);
		this._register(this._configurationService.onDidChangeConfiguration((e: IConfigurationChangeEvent) => {
			if (!e.affectsConfiguration(InlineChatDecorationsContribution.GUTTER_SETTING_ID)) {
				return;
			}
			this._onEnablementOrModelChanged();
		}));
		this._register(this._inlineChatService.onDidChangeProviders(() => this._onEnablementOrModelChanged()));
		this._register(this._editor.onDidChangeModel(() => this._onEnablementOrModelChanged()));
		this._register(this._debugService.getModel().onDidChangeBreakpoints(() => this._onEnablementOrModelChanged()));
		this._register(this._keybindingService.onDidUpdateKeybindings(() => {
			this._updateDecorationHover();
			this._onEnablementOrModelChanged();
		}));
		this._updateDecorationHover();
		this._onEnablementOrModelChanged();
	}

	private _registerGutterDecoration(isTransparent: boolean): ModelDecorationOptions {
		return ModelDecorationOptions.register({
			description: 'inline-chat-decoration',
			glyphMarginClassName: ThemeIcon.asClassName(isTransparent ? GUTTER_INLINE_CHAT_TRANSPARENT_ICON : GUTTER_INLINE_CHAT_OPAQUE_ICON),
			glyphMargin: { position: GlyphMarginLane.Left },
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		});
	}

	private _updateDecorationHover(): void {
		const keybinding = this._keybindingService.lookupKeybinding('inlineChat.start')?.getLabel() ?? undefined;
		if (this._inlineChatKeybinding === keybinding) {
			return;
		}
		this._inlineChatKeybinding = keybinding;
		const hoverMessage = new MarkdownString(keybinding ? localize('runWithKeybinding', 'Start Inline Chat [{0}]', keybinding) : LOCALIZED_START_INLINE_CHAT_STRING);
		this._gutterDecorationTransparent.glyphMarginHoverMessage = hoverMessage;
		this._gutterDecorationOpaque.glyphMarginHoverMessage = hoverMessage;
	}

	private _onEnablementOrModelChanged(): void {
		// cancels the scheduler, removes editor listeners / removes decoration
		this._localToDispose.clear();
		if (!this._editor.hasModel() || this._showGutterIconMode() === ShowGutterIcon.Never || !this._hasProvider()) {
			return;
		}
		const editor = this._editor;
		const decorationUpdateScheduler = new RunOnceScheduler(() => this._onSelectionOrContentChanged(editor), 100);
		this._localToDispose.add(decorationUpdateScheduler);
		this._localToDispose.add(this._editor.onDidChangeCursorSelection(() => decorationUpdateScheduler.schedule()));
		this._localToDispose.add(this._editor.onDidChangeModelContent(() => decorationUpdateScheduler.schedule()));
		const onInlineChatSessionChanged = (e: ICodeEditor) => (e === editor) && decorationUpdateScheduler.schedule();
		this._localToDispose.add(this._inlineChatSessionService.onWillStartSession(onInlineChatSessionChanged));
		this._localToDispose.add(this._inlineChatSessionService.onDidEndSession(onInlineChatSessionChanged));
		this._localToDispose.add(this._editor.onMouseDown(async (e: IEditorMouseEvent) => {
			const showGutterIconMode = this._showGutterIconMode();
			const gutterDecorationClassName = showGutterIconMode === ShowGutterIcon.Always ?
				InlineChatDecorationsContribution.GUTTER_ICON_OPAQUE_CLASSNAME :
				(showGutterIconMode === ShowGutterIcon.MouseOver ?
					InlineChatDecorationsContribution.GUTTER_ICON_TRANSPARENT_CLASSNAME : undefined);
			if (!gutterDecorationClassName || !e.target.element?.classList.contains(gutterDecorationClassName)) {
				return;
			}
			InlineChatController.get(this._editor)?.run();
		}));
		this._localToDispose.add({
			dispose: () => {
				if (this._gutterDecorationID) {
					this._removeGutterDecoration(this._gutterDecorationID);
				}
			}
		});
		decorationUpdateScheduler.schedule();
	}

	private _onSelectionOrContentChanged(editor: IActiveCodeEditor): void {
		const selection = editor.getSelection();
		const model = editor.getModel();
		const uri = model.uri;
		const isInlineChatVisible = this._inlineChatSessionService.getSession(editor, uri);
		const startLineNumber = selection.startLineNumber;
		const hasBreakpoint = this._debugService.getModel().getBreakpoints({ uri: uri, lineNumber: startLineNumber }).length > 0;
		const isEnabled = selection.isEmpty() && /^\s*$/g.test(model.getLineContent(startLineNumber)) && !isInlineChatVisible && !hasBreakpoint;
		if (isEnabled) {
			if (this._gutterDecorationID === undefined) {
				this._addGutterDecoration(startLineNumber);
			} else {
				const decorationRange = model.getDecorationRange(this._gutterDecorationID);
				if (decorationRange?.startLineNumber !== startLineNumber) {
					this._updateGutterDecoration(this._gutterDecorationID, startLineNumber);
				}
			}
		} else if (this._gutterDecorationID) {
			this._removeGutterDecoration(this._gutterDecorationID);
		}
	}

	private _showGutterIconMode(): ShowGutterIcon {
		return this._configurationService.getValue<ShowGutterIcon>(InlineChatDecorationsContribution.GUTTER_SETTING_ID);
	}

	private _hasProvider(): boolean {
		return !Iterable.isEmpty(this._inlineChatService.getAllProvider());
	}

	private _addGutterDecoration(lineNumber: number) {
		this._editor.changeDecorations((accessor: IModelDecorationsChangeAccessor) => {
			const showGutterIconMode = this._showGutterIconMode();
			if (showGutterIconMode === ShowGutterIcon.Never) {
				return;
			}
			this._gutterDecorationID = accessor.addDecoration(new Range(lineNumber, 0, lineNumber, 0), showGutterIconMode === ShowGutterIcon.Always ? this._gutterDecorationOpaque : this._gutterDecorationTransparent);
		});
	}

	private _removeGutterDecoration(decorationId: string) {
		this._editor.changeDecorations((accessor: IModelDecorationsChangeAccessor) => {
			accessor.removeDecoration(decorationId);
		});
		this._gutterDecorationID = undefined;
	}

	private _updateGutterDecoration(decorationId: string, lineNumber: number) {
		this._editor.changeDecorations((accessor: IModelDecorationsChangeAccessor) => {
			accessor.changeDecoration(decorationId, new Range(lineNumber, 0, lineNumber, 0));
		});
	}

	override dispose() {
		super.dispose();
		this._localToDispose.dispose();
	}
}

GutterActionsRegistry.registerGutterActionsGenerator(({ lineNumber, editor, accessor }, result) => {
	const inlineChatService = accessor.get(IInlineChatService);
	const noProviders = Iterable.isEmpty(inlineChatService.getAllProvider());
	if (noProviders) {
		return;
	}
	const preferencesService = accessor.get(IPreferencesService);
	result.push(new Action(
		'inlineChat.configureShowGutterIcon',
		localize('configureShowGutterIcon', "Configure Inline Chat Icon"),
		undefined,
		true,
		() => { preferencesService.openUserSettings({ query: 'inlineChat.showGutterIcon' }); }
	));
});
