-- EST Karaoke Server v2
-- Replaces ServerScriptService.KaraokeServer.
-- Website/Railway owns the song catalog. This script runs booths, queue,
-- singer authorization, join requests, mic lending, mic settings and playback.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local CollectionService = game:GetService("CollectionService")
local DataStoreService = game:GetService("DataStoreService")

local Songs = require(ReplicatedStorage:WaitForChild("KaraokeSongs"))

local TAG = "KaraokeBooth"
local RANGE = 60
local MAX_QUEUE = 20
local GAP = 3
local MIC_PREFS_STORE = DataStoreService:GetDataStore("EST_KaraokeMicPrefs_v1")

local booths = {}
local micPrefs = {}

local folder = ReplicatedStorage:FindFirstChild("KaraokeRemotes")
if not folder then
	folder = Instance.new("Folder")
	folder.Name = "KaraokeRemotes"
	folder.Parent = ReplicatedStorage
end

local function remote(className, name)
	local value = folder:FindFirstChild(name)
	if not value then
		value = Instance.new(className)
		value.Name = name
		value.Parent = folder
	end
	return value
end

local reserveFn = remote("RemoteFunction", "Reserve")
local cancelFn = remote("RemoteFunction", "Cancel")
local skipFn = remote("RemoteFunction", "Skip")
local stateFn = remote("RemoteFunction", "GetState")
local libraryFn = remote("RemoteFunction", "GetLibrary")
local saveFn = remote("RemoteFunction", "SaveSong")
local deleteFn = remote("RemoteFunction", "DeleteSong")
local changedEvent = remote("RemoteEvent", "LibraryChanged")
local requestJoinFn = remote("RemoteFunction", "RequestJoin")
local respondJoinFn = remote("RemoteFunction", "RespondJoin")
local micSettingsFn = remote("RemoteFunction", "SetMicSettings")

local function nowTime()
	return workspace:GetServerTimeNow()
end

local function nearBooth(player, part)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	return root ~= nil and (root.Position - part.Position).Magnitude <= RANGE
end

local function cleanMicPrefs(input)
	input = type(input) == "table" and input or {}
	return {
		bass = math.clamp(tonumber(input.bass) or 0, -12, 12),
		treble = math.clamp(tonumber(input.treble) or 0, -12, 12),
		echo = math.clamp(tonumber(input.echo) or 0.25, 0, 1),
	}
end

local function applyMicPrefsAttributes(player)
	local prefs = micPrefs[player.UserId] or cleanMicPrefs(nil)
	player:SetAttribute("KaraokeMicBass", prefs.bass)
	player:SetAttribute("KaraokeMicTreble", prefs.treble)
	player:SetAttribute("KaraokeMicEcho", prefs.echo)
end

local function loadMicPrefs(player)
	local ok, data = pcall(function()
		return MIC_PREFS_STORE:GetAsync(tostring(player.UserId))
	end)
	micPrefs[player.UserId] = cleanMicPrefs(ok and data or nil)
	applyMicPrefsAttributes(player)
end

local function saveMicPrefs(player)
	local prefs = micPrefs[player.UserId]
	if not prefs then return end
	task.spawn(function()
		local ok, err = pcall(function()
			MIC_PREFS_STORE:SetAsync(tostring(player.UserId), prefs)
		end)
		if not ok then warn("[Karaoke] couldn't save mic settings: " .. tostring(err)) end
	end)
end

local function findLentMic(player)
	for _, container in ipairs({ player.Character, player:FindFirstChildOfClass("Backpack") }) do
		if container then
			for _, item in ipairs(container:GetChildren()) do
				if item:IsA("Tool") and item:GetAttribute("KaraokeLent") then
					return item
				end
			end
		end
	end
	return nil
end

local function giveMic(player)
	if not player or not player.Parent then return end
	local character = player.Character
	local backpack = player:FindFirstChildOfClass("Backpack")
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not character or not backpack or not humanoid then return end

	local mic = findLentMic(player)
	if not mic then
		local template = ServerStorage:FindFirstChild("KaraokeMic")
		if not template or not template:IsA("Tool") then
			warn("[Karaoke] ServerStorage.KaraokeMic is missing")
			return
		end
		mic = template:Clone()
		mic.Name = "Karaoke Mic"
		mic:SetAttribute("KaraokeLent", true)
		mic.Parent = backpack
	end
	pcall(function() humanoid:EquipTool(mic) end)
end

local function takeMic(player)
	if not player then return end
	for _, container in ipairs({ player.Character, player:FindFirstChildOfClass("Backpack") }) do
		if container then
			for _, item in ipairs(container:GetChildren()) do
				if item:IsA("Tool") and item:GetAttribute("KaraokeLent") then
					item:Destroy()
				end
			end
		end
	end
end

local function currentContainsUser(current, userId)
	if not current then return false end
	for _, singer in ipairs(current.singers) do
		if singer.userId == userId then return true end
	end
	return false
end

local function userAuthorizedAnywhere(userId)
	for _, booth in pairs(booths) do
		if currentContainsUser(booth.current, userId) then return true end
	end
	return false
end

local function refreshMicAuthorization(userId)
	local player = Players:GetPlayerByUserId(userId)
	if not player then return end
	local authorized = userAuthorizedAnywhere(userId)
	player:SetAttribute("KaraokeMicAuthorized", authorized)
	if authorized then
		applyMicPrefsAttributes(player)
		giveMic(player)
	else
		takeMic(player)
	end
end

local function singerNames(current)
	if not current then return "" end
	local names = {}
	for _, singer in ipairs(current.singers) do table.insert(names, singer.name) end
	return table.concat(names, " + ")
end

local function publish(booth)
	local part = booth.part
	local current = booth.current
	part:SetAttribute("Playing", current ~= nil)
	part:SetAttribute("Number", current and current.number or "")
	part:SetAttribute("Title", current and current.title or "")
	part:SetAttribute("Artist", current and current.artist or "")
	part:SetAttribute("Singer", singerNames(current))
	part:SetAttribute("SingerCount", current and #current.singers or 0)
	part:SetAttribute("LeadUserId", current and current.leadUserId or 0)
	part:SetAttribute("StartedAt", current and current.startedAt or 0)
	part:SetAttribute("Duration", current and current.duration or 0)
	part:SetAttribute("SourceDuration", current and current.sourceDuration or 0)
	part:SetAttribute("PlaybackSpeed", current and current.speed or 1)
	part:SetAttribute("QueueCount", #booth.queue)
	local nextUp = booth.queue[1]
	part:SetAttribute("NextNumber", nextUp and nextUp.number or "")
	part:SetAttribute("NextTitle", nextUp and nextUp.title or "")
	part:SetAttribute("NextSinger", nextUp and nextUp.singerName or "")
end

local function stop(booth)
	local previous = booth.current
	booth.sound:Stop()
	booth.current = nil
	booth.freeAt = nowTime() + GAP
	publish(booth)
	if previous then
		for _, singer in ipairs(previous.singers) do refreshMicAuthorization(singer.userId) end
	end
end

local function start(booth, entry)
	local song = Songs.find(entry.number)
	if not song or song.AudioId == "" then return false end
	local speed = math.clamp(tonumber(song.Speed) or 1, 0.1, 3)
	booth.sound.SoundId = song.AudioId
	booth.sound.PlaybackSpeed = speed
	booth.sound.TimePosition = 0
	booth.sound:Play()

	local sourceDuration = booth.sound.TimeLength
	if sourceDuration <= 0 then
		local deadline = os.clock() + 8
		while booth.sound.TimeLength <= 0 and os.clock() < deadline do task.wait(0.1) end
		sourceDuration = booth.sound.TimeLength
	end
	local realDuration = sourceDuration > 0 and sourceDuration / speed or 0
	booth.current = {
		leadUserId = entry.userId,
		leadName = entry.singerName,
		number = entry.number,
		title = song.Title,
		artist = song.Artist,
		startedAt = nowTime(),
		duration = realDuration,
		sourceDuration = sourceDuration,
		speed = speed,
		singers = { { userId = entry.userId, name = entry.singerName } },
		pendingJoin = {},
	}
	refreshMicAuthorization(entry.userId)
	publish(booth)
	return true
end

local function setupBooth(part)
	if booths[part] or not part:IsA("BasePart") then return end
	local sound = part:FindFirstChild("KaraokeSound")
	if not sound then
		sound = Instance.new("Sound")
		sound.Name = "KaraokeSound"
		sound.Volume = 0.8
		sound.RollOffMaxDistance = 90
		sound.RollOffMode = Enum.RollOffMode.InverseTapered
		sound.Parent = part
	end
	local booth = { part = part, sound = sound, queue = {}, current = nil, freeAt = 0 }
	booths[part] = booth
	publish(booth)

	sound.Ended:Connect(function()
		if booth.current then stop(booth) end
	end)

	task.spawn(function()
		while part.Parent do
			task.wait(0.5)
			if not booth.current and nowTime() >= booth.freeAt and #booth.queue > 0 then
				local entry = table.remove(booth.queue, 1)
				local player = Players:GetPlayerByUserId(entry.userId)
				if player and nearBooth(player, part) then
					if not start(booth, entry) then publish(booth) end
				else
					publish(booth)
				end
			elseif booth.current and booth.current.duration > 0
				and nowTime() - booth.current.startedAt > booth.current.duration + 2 then
				stop(booth)
			end
		end
		booths[part] = nil
	end)
end

for _, part in ipairs(CollectionService:GetTagged(TAG)) do setupBooth(part) end
CollectionService:GetInstanceAddedSignal(TAG):Connect(setupBooth)

local function boothFrom(part)
	return typeof(part) == "Instance" and booths[part] or nil
end

local function singerState(current)
	local result = {}
	if current then
		for _, singer in ipairs(current.singers) do
			table.insert(result, { userId = singer.userId, name = singer.name })
		end
	end
	return result
end

local function stateOf(booth, viewer)
	local queue = {}
	for i, entry in ipairs(booth.queue) do
		table.insert(queue, {
			position = i,
			number = entry.number,
			title = entry.title,
			artist = entry.artist,
			singer = entry.singerName,
			userId = entry.userId,
		})
	end
	local current = booth.current
	local pending = {}
	if current and viewer and current.leadUserId == viewer.UserId then
		for userId, name in pairs(current.pendingJoin) do
			table.insert(pending, { userId = userId, name = name })
		end
		table.sort(pending, function(a, b) return a.userId < b.userId end)
	end
	local isSinger = current and viewer and currentContainsUser(current, viewer.UserId) or false
	return {
		playing = current ~= nil,
		current = current and {
			number = current.number,
			title = current.title,
			artist = current.artist,
			leadUserId = current.leadUserId,
			leadName = current.leadName,
			singers = singerState(current),
			startedAt = current.startedAt,
			duration = current.duration,
			sourceDuration = current.sourceDuration,
			speed = current.speed,
		} or nil,
		queue = queue,
		isSinger = isSinger,
		canRequestJoin = current ~= nil and not isSinger and viewer ~= nil and current.pendingJoin[viewer.UserId] == nil,
		joinRequestPending = current ~= nil and viewer ~= nil and current.pendingJoin[viewer.UserId] ~= nil,
		pendingJoinRequests = pending,
	}
end

stateFn.OnServerInvoke = function(player, part)
	local booth = boothFrom(part)
	return booth and stateOf(booth, player) or nil
end

libraryFn.OnServerInvoke = function()
	return { songs = Songs.all(), admin = false, readOnly = true }
end
saveFn.OnServerInvoke = function()
	return { ok = false, message = "The KTV website owns this library now." }
end
deleteFn.OnServerInvoke = function()
	return { ok = false, message = "Delete songs from the KTV website." }
end

reserveFn.OnServerInvoke = function(player, part, number)
	local booth = boothFrom(part)
	if not booth then return { ok = false, message = "That booth isn't set up" } end
	if not nearBooth(player, booth.part) then return { ok = false, message = "Go to the booth first" } end
	local song = Songs.find(number)
	if not song or song.AudioId == "" then return { ok = false, message = "No song with that number" } end
	if #booth.queue >= MAX_QUEUE then return { ok = false, message = "The queue is full" } end
	if booth.current and currentContainsUser(booth.current, player.UserId) then return { ok = false, message = "You're singing right now" } end
	for _, entry in ipairs(booth.queue) do
		if entry.userId == player.UserId then return { ok = false, message = "You already have a song waiting" } end
	end
	table.insert(booth.queue, {
		userId = player.UserId,
		singerName = player.DisplayName,
		number = tostring(song.Number),
		title = song.Title,
		artist = song.Artist,
	})
	publish(booth)
	return { ok = true, position = #booth.queue }
end

cancelFn.OnServerInvoke = function(player, part)
	local booth = boothFrom(part)
	if not booth then return { ok = false } end
	for i, entry in ipairs(booth.queue) do
		if entry.userId == player.UserId then
			table.remove(booth.queue, i)
			publish(booth)
			return { ok = true }
		end
	end
	return { ok = false, message = "Nothing to cancel" }
end

skipFn.OnServerInvoke = function(player, part)
	local booth = boothFrom(part)
	if not booth or not booth.current then return { ok = false } end
	if booth.current.leadUserId ~= player.UserId then return { ok = false, message = "Only the song requester can skip" } end
	stop(booth)
	return { ok = true }
end

requestJoinFn.OnServerInvoke = function(player, part)
	local booth = boothFrom(part)
	if not booth or not booth.current then return { ok = false, message = "Nobody is singing right now" } end
	if not nearBooth(player, booth.part) then return { ok = false, message = "Go to the booth first" } end
	if currentContainsUser(booth.current, player.UserId) then return { ok = false, message = "You're already singing" } end
	if booth.current.pendingJoin[player.UserId] then return { ok = false, message = "Your join request is already pending" } end
	booth.current.pendingJoin[player.UserId] = player.DisplayName
	return { ok = true, message = "Join request sent to " .. booth.current.leadName }
end

respondJoinFn.OnServerInvoke = function(player, part, requesterUserId, approved)
	local booth = boothFrom(part)
	if not booth or not booth.current then return { ok = false, message = "The song already ended" } end
	if booth.current.leadUserId ~= player.UserId then return { ok = false, message = "Only the song requester can approve singers" } end
	requesterUserId = tonumber(requesterUserId)
	if not requesterUserId or not booth.current.pendingJoin[requesterUserId] then return { ok = false, message = "That request is no longer pending" } end
	local name = booth.current.pendingJoin[requesterUserId]
	booth.current.pendingJoin[requesterUserId] = nil
	if approved then
		local requester = Players:GetPlayerByUserId(requesterUserId)
		if not requester or not nearBooth(requester, booth.part) then return { ok = false, message = "That player is no longer at the booth" } end
		table.insert(booth.current.singers, { userId = requesterUserId, name = name })
		refreshMicAuthorization(requesterUserId)
		publish(booth)
	end
	return { ok = true, approved = approved == true }
end

micSettingsFn.OnServerInvoke = function(player, input)
	if player:GetAttribute("KaraokeMicAuthorized") ~= true then
		return { ok = false, message = "Microphone settings only work while you're an authorized singer" }
	end
	local prefs = cleanMicPrefs(input)
	micPrefs[player.UserId] = prefs
	applyMicPrefsAttributes(player)
	saveMicPrefs(player)
	return { ok = true, settings = prefs }
end

local function removePlayerFromBooth(player, booth)
	if booth.current then
		if booth.current.leadUserId == player.UserId then
			stop(booth)
		else
			for i = #booth.current.singers, 1, -1 do
				if booth.current.singers[i].userId == player.UserId then table.remove(booth.current.singers, i) end
			end
			booth.current.pendingJoin[player.UserId] = nil
			publish(booth)
			refreshMicAuthorization(player.UserId)
		end
	end
	for i = #booth.queue, 1, -1 do
		if booth.queue[i].userId == player.UserId then table.remove(booth.queue, i) end
	end
	publish(booth)
end

Players.PlayerAdded:Connect(function(player)
	player:SetAttribute("KaraokeMicAuthorized", false)
	loadMicPrefs(player)
	player.CharacterAdded:Connect(function()
		task.wait(1)
		refreshMicAuthorization(player.UserId)
	end)
end)
for _, player in ipairs(Players:GetPlayers()) do
	player:SetAttribute("KaraokeMicAuthorized", false)
	task.spawn(loadMicPrefs, player)
end

Players.PlayerRemoving:Connect(function(player)
	for _, booth in pairs(booths) do removePlayerFromBooth(player, booth) end
	micPrefs[player.UserId] = nil
end)

-- Tell clients to rebuild if Railway swaps LibraryJson.
task.spawn(function()
	local runtime = ReplicatedStorage:WaitForChild("KaraokeRuntime", 30)
	local value = runtime and runtime:WaitForChild("LibraryJson", 10)
	if value and value:IsA("StringValue") then
		value.Changed:Connect(function() changedEvent:FireAllClients(Songs.all()) end)
	end
end)
