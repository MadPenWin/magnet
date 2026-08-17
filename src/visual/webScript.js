const vscode = acquireVsCodeApi()
class MessageLayout {
	constructor(
		role,
		txt
	) {
		this.role = role
		this.txt = txt
	}

	render() {

		const el = document.createElement('div')
		el.className = 'msg-bub ' + this.role

		const parts = this.txt.split(/(```[\s\S]*?```)/g)
		parts.forEach(part => {
			if (!part) {
				return
			}

			const codeMatch = part.match(/^```([a-zA-Z0-9+#.-]*)\r?\n([\s\S]*?)\r?\n?```$/)
			if (codeMatch) {
				const lang = codeMatch[1] || ''
				const code = codeMatch[2]

				const preEl = document.createElement('pre')
				const codeEl = document.createElement('code')

				codeEl.className = lang ? 'lang-' + lang : ''
				codeEl.textContent = code

				preEl.appendChild(codeEl)
				el.appendChild(preEl)
			} else {
				const textEl = document.createElement('div')
				textEl.style.whiteSpace = 'pre-wrap'
				textEl.textContent = part
				el.appendChild(textEl)
			}
		})

		return el
	}
}

class UserInputLayout {
	constructor(onSend) {
		this.onSend = onSend
		this.build()
	}

	build() {
		const area = document.createElement('div')
		area.className = 'input-area'

		const row = document.createElement('div')
		row.className = 'input-row'

		this.textarea = document.createElement('textarea')
		this.textarea.id = 'user-input'
		this.textarea.placeholder = 'Ask AI'
		this.textarea.rows = 1

		this.sendBtn = document.createElement('button')
		this.sendBtn.id = 'send-btn'
		this.sendBtn.innerHTML = '<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\' fill=\'currentColor\' class=\'bi bi-arrow-up-short\' viewBox=\'0 0 16 16\'><path fill-rule=\'evenodd\' d=\'M8 12a.5.5 0 0 0 .5-.5V5.707l2.146 2.147a.5.5 0 0 0 .708-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 5.707V11.5a.5.5 0 0 0 .5.5\'/></svg>'

		row.appendChild(this.textarea)
		row.appendChild(this.sendBtn)

		area.appendChild(row)
		this.attachEvent()

		document.getElementById('lay-cont')?.appendChild(area)
	}

	attachEvent() {

		this.sendBtn.addEventListener('click', () => this.submit())
		this.textarea.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault()
				this.submit()
			}
		})

		this.textarea.addEventListener('input', () => {
			this.textarea.style.height = 'auto'
			this.textarea.style.height = Math.min(this.textarea.scrollHeight, 400) + 'px' // Maximum Height Of Textarea

			if (document.getElementById('char-count')) {
				document.getElementById('char-count').textContent = String(this.textarea.value.length)
			}
		})
	}

	submit() {

		const txtarea = this.textarea.value.trim()
		if (!txtarea) {
			return
		}

		this.onSend(txtarea)

		this.textarea.value = ''
		this.textarea.style.height = 'auto'

		const counter = document.getElementById('char-count')
		if (counter) {
			counter.textContent = '0'
		}
	}
}

class ChatPanelContainer {
	constructor() {
		this.actStreamEl = null
		this.acmStreamTxt = ''

		this.isUserScrlUp = false

		this.bannerEl = document.createElement('div')
		this.bannerEl.id = 'mem-cont'
		this.bannerEl.textContent = 'Connecting To OS...'

		document.getElementById('lay-cont').appendChild(this.bannerEl)

		this.msgEl = document.createElement('div')
		this.msgEl.className = 'msg-cont'

		document.getElementById('lay-cont').appendChild(this.msgEl)

		this.msgEl.addEventListener('scroll', () => {
			const threshold = 5 // Pixel Tolerance From The Bottom
			const isAtBtm = (this.msgEl.scrollHeight - this.msgEl.scrollTop - this.msgEl.clientHeight) <= threshold

			this.isUserScrlUp = !isAtBtm
		})

		this.inputLay = new UserInputLayout((txt) => this.sendUserMsg(txt))
	}

	updateMemStats(stats) {
		if (this.bannerEl) {
			this.bannerEl.textContent = `${ stats }`
		}
	}

	sendUserMsg(txt) {
		this.appendMsg('user', txt)
		this.scrlToBtm(true)

		vscode.postMessage({
			type: 'userMsg',
			text: txt
		}
	)}

	appendMsg(role, txt) {
		this.msgEl.appendChild(new MessageLayout(role, txt).render())
		this.scrlToBtm()
	}

	startThinking(isCodeFix = false) {
		if (!this.actStreamEl) {
			const el = document.createElement('div')
			el.className = 'msg-bub assistant assistant-thinking'
			el.textContent = isCodeFix ? 'Debugging Code...' : 'Processing AI Thought...'
			el.style.color = '#95a1a1'

			this.actStreamEl = el
			this.acmStreamTxt = ''

			this.msgEl.appendChild(this.actStreamEl)
			this.scrlToBtm()
		}
	}

	updateThinkingChunk(txt) {
		if (!this.actStreamEl) {
			this.startThinking()
		}

		this.actStreamEl.className = 'msg-bub assistant assistant-thinking'
		this.actStreamEl.textContent = txt
		this.actStreamEl.style.color = '#95a1a1'

		this.scrlToBtm()
	}

	startStreamContent() {
		if (this.actStreamEl) {
			if (this.actStreamEl.classList.contains('assistant-thinking')) {
				this.actStreamEl.classList.remove('assistant-thinking')
				this.actStreamEl.classList.add('assistant-streaming')
				this.actStreamEl.style.color = '#a29e9e'
				this.acmStreamTxt = ''
				this.actStreamEl.textContent = ''

				return
			}

			this.actStreamEl.remove()
		}

		const el = document.createElement('div')
		el.className = 'msg-bub assistant assistant-streaming'
		el.style.color = '#a29e9e'

		this.actStreamEl = el
		this.acmStreamTxt = ''

		this.msgEl.appendChild(this.actStreamEl)
		this.scrlToBtm()
	}

	updateStreamChunk(txt) {
		if (
			!this.actStreamEl || 
			this.actStreamEl.classList.contains('assistant-thinking')
		) {
			this.startStreamContent()
		}

		this.acmStreamTxt += txt
		this.actStreamEl.textContent = this.acmStreamTxt

		this.scrlToBtm()
	}

	endStream(finalTxt) {
		if (this.actStreamEl) {
			this.actStreamEl.remove()
			this.actStreamEl = null
		}

		this.appendMsg('assistant', finalTxt)
	}

	codeFixed() {
		if (this.actStreamEl) {
			this.actStreamEl.textContent = 'Code Debugged'
			this.actStreamEl.style.color = '#50b450'
			this.actStreamEl = null

			this.acmStreamTxt = ''
		}
	}

	clear() {
		this.msgEl.innerHTML = ''

		this.actStreamEl = null
		this.acmStreamTxt = ''

		this.isUserScrlUp = false
	}

	scrlToBtm(force = false) {
		if (!this.isUserScrlUp || force) {
			this.msgEl.scrollTop = this.msgEl.scrollHeight
		}
	}
}

const wrapper = new ChatPanelContainer()
let isLoadingMore = false

window.addEventListener('message', e => {

	const msg = e.data
	if (msg.type === 'aiMsg') {
		wrapper.appendMsg(msg.role, msg.text)
	} else if (msg.type === 'aiThinkingStart') {
		wrapper.startThinking(msg.isCodeFix)
	} else if (msg.type === 'aiThinkingChunk') {
		wrapper.updateThinkingChunk(msg.text)
	} else if (msg.type === 'aiStreamStart') {
		wrapper.startStreamContent()
	} else if (msg.type === 'aiStreamChunk') {
		wrapper.updateStreamChunk(msg.text)
	} else if (msg.type === 'aiStreamEnd') {
		wrapper.endStream(msg.text)
	} else if (msg.type === 'aiCodeFixed') {
		wrapper.codeFixed()
	} else if (msg.type === 'memStats') {
		wrapper.updateMemStats(msg.text)
	} else if (msg.type === 'appndOldMsg') {

		const oldScrlHg = wrapper.msgEl.scrollHeight
		const fragment = document.createDocumentFragment()

		msg.messages.forEach(m => {
			fragment.insertBefore(
				new MessageLayout(m.role, m.content).render(),
				fragment.firstChild
			)
		})

		wrapper.msgEl.insertBefore(fragment, wrapper.msgEl.firstChild)
		wrapper.msgEl.scrollTop = wrapper.msgEl.scrollHeight - oldScrlHg

		isLoadingMore = false
	}
})

vscode.postMessage({
	type: 'webvwReady'
}) // Only Ready After Listener Exists

wrapper.msgEl.addEventListener('scroll', () => {
	if (wrapper.msgEl.scrollTop === 0 && !isLoadingMore) {
		isLoadingMore = true
		vscode.postMessage({
			type: 'loadMoreMsg'
		})
	}
})