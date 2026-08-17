import * as vscode from 'vscode'
import * as os from 'os'
import * as si from 'systeminformation'
import * as fs from 'fs'
import * as path from 'path'

type Role = 'user' | 'assistant' | 'system'
type Memory = {
	role: Role
	content: string
}

class ChatPanel implements vscode.WebviewViewProvider, vscode.CodeLensProvider {
	public static readonly WEBVIEW_ID = 'chatPanel'
	private static readonly MEMORY_NAME = 'chat-memory.json'
	private static readonly MAX_MEMORY = 4 // Number Of Current Message That AI Can Remember
	private readonly BATCH_SIZE: number = 2 // How Many Message To Load

	private view?: vscode.WebviewView // Initialize Webview
	private storageUri: vscode.Uri // Storage Uri For Memory
	private extensionUri: vscode.Uri // Extension Uri For Webview Uri
	private memUri: Memory[] = [] // Memory Uri For Memory

	private allMsg: Array<{
		role: string,
		content: string
	}> = []
	private totalLoadedMsg: number = 4 // Total Of Loaded Message

	private pendFix: {
		txtEditor: vscode.TextEditor // Get VSC Text Editor
		origRg: vscode.Range // User's Selected Code Block Range
		prevwRg: vscode.Range // AI's Fixed Code Block Range
		origCode: string // User's Code Block
		fixedCode: string // AI's Fixed Code Block
	} | null = null
	private bugDecor: vscode.TextEditorDecorationType
	private fixDecor: vscode.TextEditorDecorationType

	private statsInterv: NodeJS.Timeout | null = null // Amount Of Time To Wait For New Server Response
	private evEmitter = new vscode.EventEmitter<void>() // React To Specific Events

	constructor(
		storageUri: vscode.Uri,
		extensionUri: vscode.Uri
	) {
		this.storageUri = storageUri
		this.extensionUri = extensionUri
		this.memUri = this.loadMem()

		this.bugDecor = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 0, 0, 0.15)',
			isWholeLine: true
		}) // Configure User's Selected Code Block CodeLens
		this.fixDecor = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(50, 90, 80, 0.5)',
			isWholeLine: true
		}) // Configure AI's Fixed Code Block CodeLens
	}

	provideCodeLenses(
		doc: vscode.TextDocument,
		_token: vscode.CancellationToken
	): vscode.CodeLens[] {

		const currDocUri = doc.uri.toString()
		const pendFixDocUri = this.pendFix?.txtEditor.document.uri.toString()

		if (
			!this.pendFix || 
			currDocUri !== pendFixDocUri
		) {
			return []
		}

		const origCodeLines = this.pendFix.origCode.split(/\r?\n/).length // Total Lines Of User's Selected Code Block
		const prevwCodeStart = this.pendFix.prevwRg.start.line // Start Line Of Preview Code

		const i: number = origCodeLines + 1 + prevwCodeStart // Codelens Index
		const lensRg = new vscode.Range(i, 0, i, 0) // CodeLens's Actual Position

		const applyLens = new vscode.CodeLens(lensRg, {
			title: 'Apply',
			command: 'aiCodeFix.apply'
		}) // CodeLens For 'Apply'

		const cancelLens = new vscode.CodeLens(lensRg, {
			title: 'Cancel',
			command: 'aiCodeFix.cancel'
		}) // CodeLens For 'Cancel'

		return [applyLens, cancelLens]
	}

	resolveWebviewView(
		webview: vscode.WebviewView,
		_contxt: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {

		this.view = webview // Store Webview

		webview.webview.options = {
			enableScripts: true // Enable User's Script
		}
		webview.webview.html = this.html() // Add HTML

		this.memUsg().then(stats => {
			this.toWebvw({
				type: 'memStats',
				text: stats
			})
		})

		if (this.statsInterv) {
			clearInterval(this.statsInterv)
		}

		this.statsInterv = setInterval(async () => {
			this.toWebvw({
				type: 'memStats',
				text: await this.memUsg()
			})
		}, 1000) // Model's Response Stats Speed (Every 1 Second)

		webview.webview.onDidReceiveMessage(async msg => {
			switch (msg.type) {
				case 'userMsg':
					if (typeof msg.text === 'string') {
						await this.handlUserMsg(msg.text)
					}
					break

				case 'clearMsg':
					await this.clearMem()
					break

				case 'loadMoreMsg': 
					const batch = this.loadMoreMsg()
					this.toWebvw({
						type: 'appndOldMsg',
						messages: batch.msg,
						hasMore: batch.more
					})
					break

				case 'webvwReady':
					this.replayMem()
					const stats = await this.memUsg()
					this.toWebvw({
						type: 'memStats',
						text: stats
					})
					break
			}
		})

		webview.onDidDispose(() => {
			if (this.statsInterv) {
				clearInterval(this.statsInterv)
				this.statsInterv = null
			}
		})
	}

	private async memUsg(): Promise<string> {
		try {
			const format = (bytes: number): string => {
				if (bytes === 0) {
					return '0B'
				}

				const sz: Array<string> = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB']
				const i: number = Math.floor(Math.log(bytes) / Math.log(1024))

				return `${ parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) }${ sz[i] }`
			}

			const sysMem: string = format(os.totalmem() - os.freemem())
			const procMem: string = format(process.memoryUsage().rss) // Total Memory Allocated For The Process In RAM

			const cpuLoad = await si.currentLoad().catch(() => ({
				currentLoad: 0
			}))
			const cpuPct: string = cpuLoad.currentLoad.toFixed(0) // Get CPU Percentage

			const resp: Response | null = await fetch('http://localhost:11434/api/ps').catch(() => null)

			let modelStats: string = 'Offline'
			let modelUsg: string = `CPU: ${ cpuPct }%`

			if (resp && resp.ok) {
				const data = await resp.json() as {
					models: Array<{
						name: string
						size: number
						sizevram: number
					}>
				} ?? { data: 0 }

				if (data.models && data.models.length > 0) {
					modelStats = `Loaded: ${ data.models.map(m => m.name).join(' ') ?? 'Unknown Model' }`

					const model = data.models[0]!
					const gpuPct = model.size > 0 ? (model.sizevram / model.size) * 100 : 0

					if (gpuPct > 0) {
						modelUsg = `GPU: ${ gpuPct.toFixed(0) }% | CPU: ${ cpuPct }%`
					} else {
						modelUsg = `CPU: ${ cpuPct }%`
					} // Show GPU And CPU Usage If GPU > 0, Otherwise Log The CPU Usage Only
				} else {
					modelStats = 'Idle'
				} // If The Extension Didn't Get Any Sign From Server, Make The Model Idle
			}
			return `${ modelStats } | ${ modelUsg } | RAM: ${ sysMem } | Proc: ${ procMem }` // Log Memory Stats
		} catch {
			return 'Telemetry Error'
		} // Cannot Load The Telemetry
	}

	private get memFile(): string {
		return path.join(
			this.storageUri.fsPath,
			ChatPanel.MEMORY_NAME
		)
	} // Memory File Location

	private loadMem(): Memory[] {
		try {
			if (!fs.existsSync(this.memFile)) {
				return []
			}
			// vscode.window.showInformationMessage(`Load Chat Memory From: ${ this.memFile }`) // Uncomment This Line To Find The Memory Location

			const read = fs.readFileSync(this.memFile, 'utf-8')
			const parsed = JSON.parse(read)

			if (!Array.isArray(parsed)) {
				return []
			}

			const validMem = parsed.filter((sys): sys is Memory => 
				sys && 
				typeof sys.content === 'string' && 
				(
					sys.role === 'user' || 
					sys.role === 'assistant' || 
					sys.role === 'system'
				)
			)

			this.allMsg = validMem.map(m => ({
				role: m.role,
				content: m.content
			}))

			return validMem
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			vscode.window.showErrorMessage(`Failed To Load Chat From Memory: ${ errMsg }`)
			return []
		}
	}

	private saveMem(): void {
		try {
			if (!fs.existsSync(this.storageUri.fsPath)) {
				vscode.window.showWarningMessage(`No Memory File Exist. Creating Memory File At ${ this.storageUri.fsPath }`)}

				fs.mkdirSync(
					this.storageUri.fsPath, 
					{ recursive: true }
				)

				fs.writeFileSync(
					this.memFile, JSON.stringify(this.memUri, null, 2),
					'utf-8'
				)
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			vscode.window.showErrorMessage(`Failed Store Chat To Memory: ${ errMsg }`)
		}
	}

	public getInitMsg() {
		return this.allMsg.slice(-this.totalLoadedMsg)
	} // Only Load The Customized Current Messages

	public loadMoreMsg() {
		const prevSz = this.totalLoadedMsg
		this.totalLoadedMsg += this.BATCH_SIZE // Adding Up In Total
		const start = Math.max(0, this.allMsg.length - this.totalLoadedMsg) // Starts From Last Index Of Added Messages
		const end = Math.max(0, this.allMsg.length - prevSz) // Ends At The Start Of Unloaded Message
		return {
			msg: this.allMsg.slice(start, end), 
			more: start > 0
		}
	}

	private replayMem() {
		for (const item of this.getInitMsg()) {
			this.toWebvw({
				type: 'aiMsg',
				role: item.role,
				text: item.content
			})
		}
	}

	private async sendMsg(
		memory: {
			role: 'user' | 'assistant' | 'system'
			content: string
		}[], 

		onChunk: (
			chunk: string,
			isThinking: boolean
		) => void
	): Promise<string> {
		const resp: Response | null = await fetch('http://localhost:11434/api/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: 'qwen3-gpu', 
				messages: memory,
				stream: true,
				keepalive: '15m'
			})
		}) ?? { data: 0 } // Configure AI Performance

		if (!resp.ok || !resp.body) {
			throw new Error(`Model Error: ${ resp.statusText }`
		)} // Cannot Get Model Response

		let fullAIRepl = ''
		let aiThinkProc = 'AI Thinking:\n' // AI Thinking Mode

		const reader = resp.body.getReader()
		const dcoder = new TextDecoder()

		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}

			const chunk = dcoder.decode(
				value, 
				{ stream: true }
			)

			const lines = chunk.split('\n')
			for (const line of lines) {
				if (!line) {
					continue
				}

				if (JSON.parse(line).message) {
					const inf = JSON.parse(line).message.thinking
					const content = JSON.parse(line).message.content ?? ''

					if (inf) {
						aiThinkProc = inf
						onChunk(aiThinkProc, true)
					}

					if (content) {
						fullAIRepl += content
						onChunk(fullAIRepl, false)
					}
				}
			}
		}
		return fullAIRepl
	}

	private async handlUserMsg(msg: string) {
		try {
			const actEditor = vscode.window.activeTextEditor

			const selection = actEditor ? actEditor.selection : null
			const selectedCode = selection && !selection.isEmpty && actEditor ? actEditor.document.getText(selection) : ''

			const isCodeFix: boolean = Boolean(actEditor && selection && selectedCode)
			let promptedMsg: string = msg

			if (isCodeFix) {
				const folder = vscode.workspace.workspaceFolders?.[0]
				if (!folder) {
					vscode.window.showErrorMessage(`Cannot Find Main Folder Directory: ${ JSON.stringify(folder, null, 2) }`)
					return
				}

				vscode.window.showInformationMessage(`Main Folder Has Found: ${ JSON.stringify(folder, null, 2) }`)

				const pattern = new vscode.RelativePattern(folder, '*.{ts,js,c,cpp,h,hh,html}') // File Types Detection
				const fileUris = await vscode.workspace.findFiles(pattern, '**/node_modules/**')

				// WARNING: This Code Block Might Reduce Your Device Performance And Response Time If You Work With A Big Project
				let allCodes = ''
				for (const uri of fileUris) {
					try {
						const doc = await vscode.workspace.openTextDocument(uri)
						allCodes += '<fileStart>' + `From file: ${ uri.fsPath }; Code inside: ${ doc.getText() }` + '<fileEnd>' // Append Each Lines Of Code From Each Every File
					} catch(err) {
						vscode.window.showErrorMessage(`Failed To Read File: ${ uri.fsPath }`)
					}
				}

				// Configure The Prompt Here For 'Debugging Code'
				promptedMsg = `
					user's request:${ msg };
					user's code needed to be fix:${ selectedCode };
					all of user's code from all files:${ allCodes };
					user rules:Return only executable code inside a standard markdown code block. Do not include markdown explanations, conversational filler, greetings, or notes. Preserve exact indentation, tabulations, line breaks, and formatting style of the original code block without modification. Return only the fixed code of user's selected code block!
				`
			} else {
				this.memUri.push({
					role: 'user',
					content: msg
				})

				this.saveMem()
			}

			const currMem = this.memUri.slice(-ChatPanel.MAX_MEMORY, -1)
			const enhancedMsgForAI: Memory[] = [
				...currMem, {
					role: 'user',
					content: promptedMsg
				}
			] // Get Current Memory Only

			this.toWebvw({
				type: 'aiThinkingStart',
				isCodeFix
			})

			let aiThinkProc: string = 'AI Thinking Process:\n'
			let hasStartedContent: boolean = false
			let lastContentSz: number = 0

			// Return Only Normal Conversation If Not A Debugging Code Type
			const reply: string = await this.sendMsg(enhancedMsgForAI, (partialText, isThinking) => {
				if (isThinking) {
					aiThinkProc += partialText
					this.toWebvw({
						type: 'aiThinkingChunk',
						text: aiThinkProc
					})
				} else {
					if (isCodeFix) {
						return
					} // Remove The Final Reply In Debugging Code Mode Inside Chat Panel

					if (!hasStartedContent) {
						hasStartedContent = true
						this.toWebvw({
							type: 'aiStreamStart'
						})
						lastContentSz = 0
					} // Start Generating Reply

					const newDelta: string = partialText.slice(lastContentSz)
					lastContentSz = partialText.length

					if (newDelta) {
						this.toWebvw({
							type: 'aiStreamChunk',
							text: newDelta
						})
					}
				}
			}) ?? ''

			const fixedCode: string = this.extrcCode(reply, selectedCode)
			if (!isCodeFix) {
				this.toWebvw({
					type: 'aiStreamEnd',
					text: reply
				})
			} // Only Apply The Final Generated Reply In Normal Conversation

			if (isCodeFix && actEditor && selection) {
				await this.showCodeFixPreview(
					actEditor,
					selection,
					selectedCode,
					fixedCode
				)
				this.toWebvw({
					type: 'aiCodeFixed'
				})
			} else {
				this.memUri.push({
					role: 'assistant',
					content: reply
				})
				this.saveMem()
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			this.toWebvw({
				type: 'aiStreamEnd',
				text: `Error: ${ errMsg || 'Something Went Wrong' }`
			})
		}
	}

	private extrcCode(
		txt: string,
		origCode: string
	): string {
		let code = txt.trim() // Get AI's Fixed Code

		const match: RegExpMatchArray | null = code.match(/^```[a-zA-Z0-9+#.-]*\r?\n([\s\S]*?)\r?\n```$/)
		if (match?.[1] !== undefined) {
			code = match[1]
		} // Remove Noise Text, Returns Only Pure Code

		const origFirstLn: string | undefined = origCode.split(/\r?\n/)[0]
		const origIndent: RegExpMatchArray | string = origFirstLn?.match(/^[\t ]*/)?.[0] ?? ''

		const lines: string[] | null = code.split(/\r?\n/)
		if (lines.length > 0 && origIndent.length > 0) {
			lines[0] = origIndent + lines[0]
		}

		return lines.join('\n').replace(/\n+$/, '')
	}

	private async showCodeFixPreview(
		txtEditor: vscode.TextEditor,
		rg: vscode.Range,
		origCode: string,
		fixedCode: string
	) {
		if (origCode.trim() === fixedCode.trim()) {
			vscode.window.showInformationMessage('AI Did Not Find Any Changes')
			return
		} // Returns No Debugger If The Fixed Similar To The Original

		if (this.pendFix) {
			vscode.window.showWarningMessage('Please Apply Or Cancel The Current AI Fix First')
			return
		} // Accept Or Cancel Debugging Request First Then Continue To Chat

		const prevw: string = `${ origCode }\n\n${ fixedCode }`
		const didEdit: boolean | null = await txtEditor.edit(editBuilder => {
			editBuilder.replace(rg, prevw)
		})

    if (!didEdit) {
      vscode.window.showErrorMessage('Unable To Create AI Code Preview')
      return
    } // Cannot Generate Fixed Code

		const prevwStart = rg.start // Starts The Fixed Code Line
		const oriLnCount: number = origCode.split(/\r?\n/).length // Total Selected Code Block Lines
		const blankLnI: number = oriLnCount + 1 + prevwStart.line// Gap Between Bug Code And Fixed code

		const prevwRg = new vscode.Range(
			prevwStart,
			new vscode.Position(prevwStart.line + prevw.split(/\r?\n/).length, 0)
		)

    this.pendFix = {
			txtEditor,
			origRg: rg,
			prevwRg,
			origCode,
			fixedCode
		}

		const bugRg: vscode.Range[] = []
		for (let ln = 0; ln < oriLnCount; ln++) {

			const lnNum: number = prevwStart.line + ln
			if (lnNum >= txtEditor.document.lineCount) {
				continue
			} // Skip If Bug Code Start Line >= Total Lines In Text Editor

			const docLn = txtEditor.document.lineAt(lnNum)
			if (docLn) {
				bugRg.push(new vscode.Range(lnNum, 0, lnNum, docLn.text.length))
			}
		}

		const fixRg: vscode.Range[] = []
		const fixedLnCount: number = fixedCode.split(/\r?\n/).length
		const fixStartLn: number = blankLnI

		for (let ln = 0; ln < fixedLnCount; ln++) {

			const lnNum: number = fixStartLn + ln
			if (lnNum >= txtEditor.document.lineCount) {
				continue
			} // Skip If Fixed Code Start Line >= Total Lines In Text Editor

			const docLn = txtEditor.document.lineAt(lnNum)
			if (docLn) {
				fixRg.push(new vscode.Range(lnNum, 0, lnNum, docLn.text.length))
			}
		}

		txtEditor.setDecorations(this.bugDecor, bugRg)
		txtEditor.setDecorations(this.fixDecor, fixRg)

		this.evEmitter.fire()
	}

	public async applyPendingFix() {
		if (!this.pendFix) {
			return
		}

		const { txtEditor, prevwRg, fixedCode } = this.pendFix
		const didEdit: boolean = await txtEditor.edit(editBuilder => {
			editBuilder.replace(prevwRg, fixedCode) 
		}) // Check If Replaced Each Copied Of Preview Range With Fixed Code Line

		if (!didEdit) {
			vscode.window.showErrorMessage('Unable To Apply AI Fix')
			return
		}

		this.clearCodeFixPreview()
	}

	public async cancelPendingFix() {
		if (!this.pendFix) {
			return
		}

		const { txtEditor, prevwRg, origCode } = this.pendFix
		const didEdit: boolean = await txtEditor.edit(editBuilder => {
			editBuilder.replace(prevwRg, origCode)
		})

		if (!didEdit) {
			vscode.window.showErrorMessage('Unable To Cancel AI Fix')
			return
		}

		this.clearCodeFixPreview()
	}

	private clearCodeFixPreview() {

		const txtEditor = this.pendFix?.txtEditor ?? vscode.window.activeTextEditor
		if (txtEditor) {
			txtEditor.setDecorations(this.bugDecor, [])
			txtEditor.setDecorations(this.fixDecor, [])
		}

		this.pendFix = null
		this.evEmitter.fire()
	}

	private async clearMem() {
		this.memUri = []

		try {
			if (fs.existsSync(this.memFile)) {
				fs.unlinkSync(this.memFile)
				vscode.window.showWarningMessage('Deleted Chat Memory')
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			vscode.window.showErrorMessage(`Failed To Delete Chat Memory: ${ errMsg }`)
		}

		this.toWebvw({ type: 'clearChat' })
	}

	private toWebvw(msg: any) {
		this.view?.webview.postMessage(msg)
	}

	private html(): string {
		const styleUri = this.view!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src/visual', 'webStyle.css'))
		const scriptUri = this.view!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src/visual', 'webScript.js'))

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8"/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
	<title>My AI Extension</title>
	<link rel="stylesheet" href="${ styleUri }">
</head>
<body>
		<div id="lay-cont"></div>
		<script src="${ scriptUri }"></script>
</body>`
	}
}

export function activate(contxt: vscode.ExtensionContext): void {
	const chatPanel = new ChatPanel(
		contxt.globalStorageUri,
		contxt.extensionUri
	)

	contxt.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatPanel.WEBVIEW_ID, chatPanel))
	contxt.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, chatPanel))
	contxt.subscriptions.push(
		vscode.commands.registerCommand('aiCodeFix.apply', () => chatPanel.applyPendingFix()),
		vscode.commands.registerCommand('aiCodeFix.cancel', () => chatPanel.cancelPendingFix())
	)
}