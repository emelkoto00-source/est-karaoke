-- EST Karaoke live microphone DSP bridge.
-- Put this Script in ServerScriptService.
-- It only creates a live mic audio graph while KaraokeMicAuthorized == true.
-- Graph: AudioDeviceInput -> AudioEqualizer -> AudioEcho -> AudioEmitter
-- The script uses pcall around Audio API construction/property writes so older
-- Studio/client builds fail safely instead of breaking the karaoke system.

local Players = game:GetService("Players")

local graphs = {}

local function safeSet(instance, property, value)
	return pcall(function()
		instance[property] = value
	end)
end

local function newAudio(className)
	local ok, instance = pcall(function()
		return Instance.new(className)
	end)
	if ok then return instance end
	return nil
end

local function destroyGraph(player)
	local graph = graphs[player]
	if graph then
		for _, instance in ipairs(graph.instances) do
			pcall(function() instance:Destroy() end)
		end
		graphs[player] = nil
	end
end

local function updateGraph(player)
	local graph = graphs[player]
	if not graph then return end
	local bass = math.clamp(tonumber(player:GetAttribute("KaraokeMicBass")) or 0, -12, 12)
	local treble = math.clamp(tonumber(player:GetAttribute("KaraokeMicTreble")) or 0, -12, 12)
	local echoAmount = math.clamp(tonumber(player:GetAttribute("KaraokeMicEcho")) or 0.25, 0, 1)

	if graph.eq then
		safeSet(graph.eq, "LowGain", bass)
		safeSet(graph.eq, "MidGain", 0)
		safeSet(graph.eq, "HighGain", treble)
	end
	if graph.echo then
		-- Roblox AudioEcho property names have evolved. Try the common variants.
		safeSet(graph.echo, "DelayTime", 0.18)
		safeSet(graph.echo, "Delay", 0.18)
		safeSet(graph.echo, "Feedback", echoAmount * 0.45)
		safeSet(graph.echo, "DryLevel", 0)
		safeSet(graph.echo, "WetLevel", -80 + (echoAmount * 72))
		safeSet(graph.echo, "Mix", echoAmount)
	end
end

local function wire(source, target, parent, instances)
	local w = newAudio("Wire")
	if not w then return false end
	local sourceOk = safeSet(w, "SourceInstance", source)
	local targetOk = safeSet(w, "TargetInstance", target)
	if not sourceOk or not targetOk then
		w:Destroy()
		return false
	end
	w.Parent = parent
	table.insert(instances, w)
	return true
end

local function buildGraph(player)
	destroyGraph(player)
	if player:GetAttribute("KaraokeMicAuthorized") ~= true then return end
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not root then return end

	local input = newAudio("AudioDeviceInput")
	local eq = newAudio("AudioEqualizer")
	local echo = newAudio("AudioEcho")
	local emitter = newAudio("AudioEmitter")
	if not input or not eq or not echo or not emitter then
		for _, instance in ipairs({ input, eq, echo, emitter }) do if instance then instance:Destroy() end end
		warn("[KaraokeMicAudio] Roblox Audio API nodes are not available. Mic authorization still works, but live Bass/Treble/Echo DSP is unavailable in this environment.")
		return
	end

	local graphFolder = Instance.new("Folder")
	graphFolder.Name = "KaraokeVoiceGraph"
	graphFolder.Parent = character
	input.Name = "KaraokeVoiceInput"
	eq.Name = "KaraokeVoiceEQ"
	echo.Name = "KaraokeVoiceEcho"
	emitter.Name = "KaraokeVoiceEmitter"

	-- AudioDeviceInput needs to capture this authorized player's voice.
	local playerAssigned = safeSet(input, "Player", player)
	if not playerAssigned then
		graphFolder:Destroy()
		input:Destroy(); eq:Destroy(); echo:Destroy(); emitter:Destroy()
		warn("[KaraokeMicAudio] AudioDeviceInput.Player could not be assigned. Check that Voice Chat / Audio API is enabled for the experience.")
		return
	end

	input.Parent = graphFolder
	eq.Parent = graphFolder
	echo.Parent = graphFolder
	emitter.Parent = root
	local instances = { graphFolder, input, eq, echo, emitter }

	local ok1 = wire(input, eq, graphFolder, instances)
	local ok2 = wire(eq, echo, graphFolder, instances)
	local ok3 = wire(echo, emitter, graphFolder, instances)
	if not (ok1 and ok2 and ok3) then
		for _, instance in ipairs(instances) do pcall(function() instance:Destroy() end) end
		warn("[KaraokeMicAudio] Could not wire the live voice graph in this Studio/client build.")
		return
	end

	graphs[player] = { instances = instances, eq = eq, echo = echo }
	updateGraph(player)
end

local function bindPlayer(player)
	player:GetAttributeChangedSignal("KaraokeMicAuthorized"):Connect(function()
		if player:GetAttribute("KaraokeMicAuthorized") == true then buildGraph(player) else destroyGraph(player) end
	end)
	for _, name in ipairs({ "KaraokeMicBass", "KaraokeMicTreble", "KaraokeMicEcho" }) do
		player:GetAttributeChangedSignal(name):Connect(function() updateGraph(player) end)
	end
	player.CharacterAdded:Connect(function()
		task.wait(1)
		if player:GetAttribute("KaraokeMicAuthorized") == true then buildGraph(player) end
	end)
	if player:GetAttribute("KaraokeMicAuthorized") == true then task.defer(buildGraph, player) end
end

Players.PlayerAdded:Connect(bindPlayer)
for _, player in ipairs(Players:GetPlayers()) do bindPlayer(player) end
Players.PlayerRemoving:Connect(destroyGraph)
