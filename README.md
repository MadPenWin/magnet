# 1: Magnet:

* A lightweight, high-performance local AI extension for VS Code designed to accelerate your development workflow, assist in communication, and debug code right inside your editor.

# 2: Key Features:

* Local AI Inference: Powered by `Ollama` and `Qwen3` for zero API cost and complete code privacy.
* Inline Debugging && Chat: Context-aware code explanations, refactoring, and bug fixing directly in your workspace.
* System Hardware Awareness: Uses `systeminformation` to monitor resource utilization during model execution.

# 3: Prerequisites:

* Before running `Magnet`, ensure you have the required runtime dependencies installed on your system.

# 3.a: Node.js && npm:

* Install via `nvm` (Node Version Manager)

	# Install 'nvm':

	* Run: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash`
	* Run: `\. "$HOME/.nvm/nvm.sh"`

	# Install 'Node.js':

	* Run: `nvm install 24`

	# Verify versions:

	* Run: `node -v (Expected output: 'v24.19.0')`
	* Run: `npm -v (Expected output: '11.17.0')`

# 4: Install ollama for your operating system:

* macOS: `curl -fsSL https://ollama.com/install.sh | sh`
* Linux: `curl -fsSL https://ollama.com/install.sh | sh`
* Windows: `irm https://ollama.com/install.ps1 | iex`

	# 4.a: Quick Start

	* Install extension dependencies: `npm install systeminformation --save`
	* Pull default model: `ollama pull qwen3:4b`
	* Verify model execution: `ollama run qwen3:4b`

	# 4.b: Configure VS Code Settings:

	* Ensure `CodeLens` is enabled in your `settings.json` or (Preferences: Open User Settings (JSON), make sure: `"editor.codeLens": true`)

	# 4.c: Model Management:

	* You can switch the underlying Qwen3 model variant based on your hardware capabilities.

		# 4.c.1: How to Switch Models:

		* Remove current model: `ollama rm qwen3:4b`
		* Pull new model size: `ollama pull qwen3:1.7b`

		# 4.c.2: Update Modelfile:

		* Navigate to your project's Modelfile and replace the base image line: `FROM qwen3:1.7b`
		* Rebuild model configuration: `ollama create qwen3-gpu -f Modelfile`

	# 4.d: Recommended Model Tiers

	* Small: 0.6b, 1.7b, 3b, 3.2b, 3.8b, 4b
	* Medium: 7b, 7.25b, 8b, 9b, 12b, 14b
	* Large: 21b, 22b, 27b, 30b, 31b, 35b, 37b, 40b, 70b
	* Massive: 105b, 123b, 176b, 205b, 405b, 671b

# 5: Known Issues && Limitations UI Panel Dragging:

* Do not drag or resize the AI extension panel while a streaming response is generating, as this may interrupt response generation progress.

# 6: Future Features:

* Support for switching `Ollama` models will be added soon

# 7: License:

* Distributed under the MIT License.