-- EST Karaoke Client v2
-- Replaces StarterPlayerScripts.KaraokeClient.
-- Live songbook + KTV lyric highlighting + singer join requests + mic EQ UI.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local ProximityPromptService = game:GetService("ProximityPromptService")
local RunService = game:GetService("RunService")

local Songs = require(ReplicatedStorage:WaitForChild("KaraokeSongs"))
local remotes = ReplicatedStorage:WaitForChild("KaraokeRemotes", 30)
if not remotes then
	warn("[Karaoke] server not found")
	return
end

local reserveFn = remotes:WaitForChild("Reserve")
local cancelFn = remotes:WaitForChild("Cancel")
local skipFn = remotes:WaitForChild("Skip")
local stateFn = remotes:WaitForChild("GetState")
local requestJoinFn = remotes:WaitForChild("RequestJoin")
local respondJoinFn = remotes:WaitForChild("RespondJoin")
local micSettingsFn = remotes:WaitForChild("SetMicSettings")
local changedEvent = remotes:WaitForChild("LibraryChanged")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
local gui = playerGui:WaitForChild("KaraokeGui")
local book = gui:WaitForChild("Book")
local list = book:WaitForChild("List")
local rowTemplate = list:WaitForChild("RowTemplate")
local numberBox = book:WaitForChild("NumberBox")
local status = book:WaitForChild("Status")
local queueLabel = book:WaitForChild("QueueLabel")

local ACCENT = Color3.fromRGB(255, 154, 46)
local KTV_BLUE = Color3.fromRGB(74, 167, 255)
local TAG = "KaraokeBooth"
local openBooth = nil
local lastState = nil

local function clock(seconds)
	seconds = math.max(0, math.floor(seconds))
	return string.format("%d:%02d", math.floor(seconds / 60), seconds % 60)
end

local function say(message, good)
	status.Text = message or ""
	status.TextColor3 = good and ACCENT or Color3.fromRGB(202, 191, 219)
end

---------------------------------------------------------------------
-- KTV highlight overlay for each booth screen
---------------------------------------------------------------------
local function ensureHighlight(now)
	local line = now:FindFirstChild("Line")
	if not line or not line:IsA("TextLabel") then return nil, nil end
	local clip = line:FindFirstChild("KTVHighlightClip")
	local overlay
	if not clip then
		clip = Instance.new("Frame")
		clip.Name = "KTVHighlightClip"
		clip.BackgroundTransparency = 1
		clip.BorderSizePixel = 0
		clip.ClipsDescendants = true
		clip.Position = UDim2.fromScale(0, 0)
		clip.Size = UDim2.fromScale(0, 1)
		clip.ZIndex = line.ZIndex + 1
		clip.Parent = line

		overlay = Instance.new("TextLabel")
		overlay.Name = "Overlay"
		overlay.BackgroundTransparency = 1
		overlay.BorderSizePixel = 0
		overlay.Position = UDim2.fromScale(0, 0)
		overlay.Size = UDim2.fromScale(1, 1)
		overlay.Font = line.Font
		overlay.TextScaled = line.TextScaled
		overlay.TextWrapped = line.TextWrapped
		overlay.TextXAlignment = line.TextXAlignment
		overlay.TextYAlignment = line.TextYAlignment
		overlay.TextStrokeColor3 = line.TextStrokeColor3
		overlay.TextStrokeTransparency = line.TextStrokeTransparency
		overlay.TextColor3 = KTV_BLUE
		overlay.ZIndex = clip.ZIndex
		overlay.Parent = clip
	else
		overlay = clip:FindFirstChild("Overlay")
	end
	return clip, overlay
end

local function drawScreen(part)
	local screen = part:FindFirstChild("KaraokeScreen")
	local board = screen and screen:FindFirstChild("Board")
	if not board then return end

	local playing = part:GetAttribute("Playing") == true
	local queued = tonumber(part:GetAttribute("QueueCount")) or 0
	board.Idle.Visible = not playing
	board.Now.Visible = playing
	board.Header.Queued.Text = queued == 0 and "no one waiting"
		or (queued == 1 and "1 waiting" or (queued .. " waiting"))

	local nextTitle = part:GetAttribute("NextTitle") or ""
	local nextNumber = part:GetAttribute("NextNumber") or ""
	local nextSinger = part:GetAttribute("NextSinger") or ""
	board.NextUp.Visible = nextTitle ~= ""
	if nextTitle ~= "" then
		board.NextUp.Text = "NEXT  " .. tostring(nextNumber) .. "  " .. tostring(nextTitle) .. "  -  " .. tostring(nextSinger)
	end
	if not playing then return end

	local now = board.Now
	now.Title.Text = part:GetAttribute("Title") or ""
	now.Artist.Text = part:GetAttribute("Artist") or ""
	now.Singer.Text = "Sung by " .. (part:GetAttribute("Singer") or "")

	local startedAt = tonumber(part:GetAttribute("StartedAt")) or 0
	local duration = tonumber(part:GetAttribute("Duration")) or 0
	local speed = tonumber(part:GetAttribute("PlaybackSpeed")) or 1
	local elapsed = math.max(0, workspace:GetServerTimeNow() - startedAt)
	if duration > 0 then elapsed = math.min(elapsed, duration) end
	local sourcePosition = elapsed * speed
	if duration > 0 then
		now.Bar.Fill.Size = UDim2.fromScale(math.clamp(elapsed / duration, 0, 1), 1)
		now.Time.Text = clock(elapsed) .. " / " .. clock(duration)
	else
		now.Bar.Fill.Size = UDim2.fromScale(0, 1)
		now.Time.Text = clock(elapsed)
	end

	local song = Songs.find(part:GetAttribute("Number"))
	local ktv = Songs.karaokeAt(song, sourcePosition)
	local clip, overlay = ensureHighlight(now)
	if song and type(song.Lyrics) == "table" and #song.Lyrics > 0 and ktv then
		now.Prev.Text = ktv.previous or ""
		now.Line.Text = ktv.current ~= "" and ktv.current or "..."
		now.Next.Text = ktv.next or ""
		if overlay then overlay.Text = now.Line.Text end
		if clip then clip.Size = UDim2.fromScale(math.clamp(ktv.progress or 0, 0, 1), 1) end
	else
		now.Prev.Text = ""
		now.Line.Text = "Lyrics are not ready for this song"
		now.Next.Text = ""
		if overlay then overlay.Text = now.Line.Text end
		if clip then clip.Size = UDim2.fromScale(0, 1) end
	end
end

local drawAccumulated = 0
RunService.Heartbeat:Connect(function(dt)
	drawAccumulated += dt
	if drawAccumulated < 0.05 then return end
	drawAccumulated = 0
	for _, part in ipairs(CollectionService:GetTagged(TAG)) do
		if part:IsA("BasePart") then drawScreen(part) end
	end
end)

---------------------------------------------------------------------
-- Programmatic social/join UI
---------------------------------------------------------------------
local socialGui = Instance.new("ScreenGui")
socialGui.Name = "KaraokeSocialGui"
socialGui.ResetOnSpawn = false
socialGui.IgnoreGuiInset = false
socialGui.Parent = playerGui

local joinButton = Instance.new("TextButton")
joinButton.Name = "JoinSinger"
joinButton.AnchorPoint = Vector2.new(0.5, 1)
joinButton.Position = UDim2.new(0.5, 0, 1, -28)
joinButton.Size = UDim2.fromOffset(210, 44)
joinButton.BackgroundColor3 = Color3.fromRGB(37, 128, 224)
joinButton.TextColor3 = Color3.new(1, 1, 1)
joinButton.Text = "🎤 Request to join singer"
joinButton.TextScaled = true
joinButton.Font = Enum.Font.GothamBold
joinButton.Visible = false
joinButton.Parent = socialGui
local joinCorner = Instance.new("UICorner")
joinCorner.CornerRadius = UDim.new(0, 10)
joinCorner.Parent = joinButton

local requestPanel = Instance.new("Frame")
requestPanel.Name = "SingerRequest"
requestPanel.AnchorPoint = Vector2.new(0.5, 0)
requestPanel.Position = UDim2.new(0.5, 0, 0, 24)
requestPanel.Size = UDim2.fromOffset(390, 126)
requestPanel.BackgroundColor3 = Color3.fromRGB(20, 23, 39)
requestPanel.Visible = false
requestPanel.Parent = socialGui
local requestCorner = Instance.new("UICorner")
requestCorner.CornerRadius = UDim.new(0, 12)
requestCorner.Parent = requestPanel
local requestText = Instance.new("TextLabel")
requestText.BackgroundTransparency = 1
requestText.Position = UDim2.fromOffset(14, 10)
requestText.Size = UDim2.new(1, -28, 0, 56)
requestText.Font = Enum.Font.GothamBold
requestText.TextColor3 = Color3.new(1, 1, 1)
requestText.TextWrapped = true
requestText.TextScaled = true
requestText.Parent = requestPanel
local approve = Instance.new("TextButton")
approve.Position = UDim2.new(0, 14, 1, -48)
approve.Size = UDim2.new(0.5, -20, 0, 36)
approve.BackgroundColor3 = Color3.fromRGB(53, 174, 119)
approve.TextColor3 = Color3.new(1, 1, 1)
approve.Text = "Approve"
approve.Font = Enum.Font.GothamBold
approve.Parent = requestPanel
local decline = approve:Clone()
decline.Position = UDim2.new(0.5, 6, 1, -48)
decline.BackgroundColor3 = Color3.fromRGB(171, 62, 83)
decline.Text = "Decline"
decline.Parent = requestPanel
for _, button in ipairs({ approve, decline }) do
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 8)
	corner.Parent = button
end

local pendingJoinUserId = nil

---------------------------------------------------------------------
-- Programmatic mic EQ top button + settings panel
---------------------------------------------------------------------
local micGui = Instance.new("ScreenGui")
micGui.Name = "KaraokeMicGui"
micGui.ResetOnSpawn = false
micGui.Parent = playerGui

local micTop = Instance.new("TextButton")
micTop.AnchorPoint = Vector2.new(1, 0)
micTop.Position = UDim2.new(1, -18, 0, 18)
micTop.Size = UDim2.fromOffset(150, 42)
micTop.BackgroundColor3 = Color3.fromRGB(24, 27, 42)
micTop.TextColor3 = Color3.new(1, 1, 1)
micTop.Text = "🎤 MIC SETTINGS"
micTop.TextScaled = true
micTop.Font = Enum.Font.GothamBold
micTop.Visible = false
micTop.Parent = micGui
local topCorner = Instance.new("UICorner")
topCorner.CornerRadius = UDim.new(0, 12)
topCorner.Parent = micTop

local micPanel = Instance.new("Frame")
micPanel.AnchorPoint = Vector2.new(1, 0)
micPanel.Position = UDim2.new(1, -18, 0, 68)
micPanel.Size = UDim2.fromOffset(330, 250)
micPanel.BackgroundColor3 = Color3.fromRGB(16, 19, 33)
micPanel.Visible = false
micPanel.Parent = micGui
local panelCorner = Instance.new("UICorner")
panelCorner.CornerRadius = UDim.new(0, 14)
panelCorner.Parent = micPanel
local panelTitle = Instance.new("TextLabel")
panelTitle.BackgroundTransparency = 1
panelTitle.Position = UDim2.fromOffset(14, 8)
panelTitle.Size = UDim2.new(1, -28, 0, 34)
panelTitle.Font = Enum.Font.GothamBold
panelTitle.TextColor3 = Color3.new(1, 1, 1)
panelTitle.Text = "Karaoke Microphone EQ"
panelTitle.TextScaled = true
panelTitle.Parent = micPanel

local controls = {}
local function makeControl(name, y, step, suffix)
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Position = UDim2.fromOffset(14, y)
	label.Size = UDim2.fromOffset(80, 36)
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.Font = Enum.Font.GothamBold
	label.TextColor3 = Color3.new(1, 1, 1)
	label.Text = name
	label.Parent = micPanel
	local minus = Instance.new("TextButton")
	minus.Position = UDim2.fromOffset(102, y)
	minus.Size = UDim2.fromOffset(42, 36)
	minus.Text = "−"
	minus.Font = Enum.Font.GothamBold
	minus.TextScaled = true
	minus.BackgroundColor3 = Color3.fromRGB(34, 39, 61)
	minus.TextColor3 = Color3.new(1, 1, 1)
	minus.Parent = micPanel
	local value = Instance.new("TextLabel")
	value.BackgroundTransparency = 1
	value.Position = UDim2.fromOffset(150, y)
	value.Size = UDim2.fromOffset(82, 36)
	value.Font = Enum.Font.GothamBold
	value.TextColor3 = Color3.fromRGB(99, 230, 190)
	value.Text = "0"
	value.TextScaled = true
	value.Parent = micPanel
	local plus = minus:Clone()
	plus.Position = UDim2.fromOffset(238, y)
	plus.Text = "+"
	plus.Parent = micPanel
	for _, b in ipairs({ minus, plus }) do
		local corner = Instance.new("UICorner")
		corner.CornerRadius = UDim.new(0, 8)
		corner.Parent = b
	end
	controls[name] = { minus = minus, plus = plus, value = value, step = step, suffix = suffix }
end
makeControl("Bass", 54, 1, " dB")
makeControl("Treble", 100, 1, " dB")
makeControl("Echo", 146, 0.05, "%")

local resetMic = Instance.new("TextButton")
resetMic.Position = UDim2.new(0, 14, 1, -50)
resetMic.Size = UDim2.new(1, -28, 0, 36)
resetMic.BackgroundColor3 = Color3.fromRGB(34, 39, 61)
resetMic.TextColor3 = Color3.new(1, 1, 1)
resetMic.Text = "Reset mic settings"
resetMic.Font = Enum.Font.GothamBold
resetMic.Parent = micPanel
local resetCorner = Instance.new("UICorner")
resetCorner.CornerRadius = UDim.new(0, 8)
resetCorner.Parent = resetMic

local micSettings = { bass = 0, treble = 0, echo = 0.25 }
local function updateMicLabels()
	controls.Bass.value.Text = string.format("%+.0f dB", micSettings.bass)
	controls.Treble.value.Text = string.format("%+.0f dB", micSettings.treble)
	controls.Echo.value.Text = string.format("%d%%", math.floor(micSettings.echo * 100 + 0.5))
end
local function loadMicAttributes()
	micSettings.bass = tonumber(player:GetAttribute("KaraokeMicBass")) or 0
	micSettings.treble = tonumber(player:GetAttribute("KaraokeMicTreble")) or 0
	micSettings.echo = tonumber(player:GetAttribute("KaraokeMicEcho")) or 0.25
	updateMicLabels()
end
local function saveMic()
	local ok, result = pcall(function() return micSettingsFn:InvokeServer(micSettings) end)
	if ok and type(result) == "table" and result.ok and result.settings then
		micSettings = result.settings
		updateMicLabels()
	end
end

controls.Bass.minus.MouseButton1Click:Connect(function() micSettings.bass = math.max(-12, micSettings.bass - 1); saveMic() end)
controls.Bass.plus.MouseButton1Click:Connect(function() micSettings.bass = math.min(12, micSettings.bass + 1); saveMic() end)
controls.Treble.minus.MouseButton1Click:Connect(function() micSettings.treble = math.max(-12, micSettings.treble - 1); saveMic() end)
controls.Treble.plus.MouseButton1Click:Connect(function() micSettings.treble = math.min(12, micSettings.treble + 1); saveMic() end)
controls.Echo.minus.MouseButton1Click:Connect(function() micSettings.echo = math.max(0, micSettings.echo - 0.05); saveMic() end)
controls.Echo.plus.MouseButton1Click:Connect(function() micSettings.echo = math.min(1, micSettings.echo + 0.05); saveMic() end)
resetMic.MouseButton1Click:Connect(function() micSettings = { bass = 0, treble = 0, echo = 0.25 }; saveMic() end)
micTop.MouseButton1Click:Connect(function() micPanel.Visible = micTop.Visible and not micPanel.Visible end)

local function micIsEquipped()
	local character = player.Character
	if not character then return false end
	for _, item in ipairs(character:GetChildren()) do
		if item:IsA("Tool") and item:GetAttribute("KaraokeLent") then return true end
	end
	return false
end
local function refreshMicUi()
	local visible = player:GetAttribute("KaraokeMicAuthorized") == true and micIsEquipped()
	micTop.Visible = visible
	if not visible then micPanel.Visible = false end
end
local function bindCharacter(character)
	character.ChildAdded:Connect(refreshMicUi)
	character.ChildRemoved:Connect(refreshMicUi)
	task.defer(refreshMicUi)
end
if player.Character then bindCharacter(player.Character) end
player.CharacterAdded:Connect(bindCharacter)
player:GetAttributeChangedSignal("KaraokeMicAuthorized"):Connect(refreshMicUi)
player:GetAttributeChangedSignal("KaraokeMicBass"):Connect(loadMicAttributes)
player:GetAttributeChangedSignal("KaraokeMicTreble"):Connect(loadMicAttributes)
player:GetAttributeChangedSignal("KaraokeMicEcho"):Connect(loadMicAttributes)
loadMicAttributes()

---------------------------------------------------------------------
-- Song book and queue
---------------------------------------------------------------------
local function buildList()
	for _, child in ipairs(list:GetChildren()) do
		if child:IsA("TextButton") and child ~= rowTemplate then child:Destroy() end
	end
	local playable = Songs.playable()
	book.EmptyNote.Visible = #playable == 0
	for i, song in ipairs(playable) do
		local row = rowTemplate:Clone()
		row.Name = "Song_" .. tostring(song.Number)
		row.Visible = true
		row.LayoutOrder = i
		row.Number.Text = tostring(song.Number)
		row.Title.Text = tostring(song.Title or "")
		row.Artist.Text = tostring(song.Artist or "")
		row.Lyrics.Text = (type(song.Lyrics) == "table" and #song.Lyrics > 0) and "KTV lyrics" or "no lyrics"
		row.Parent = list
		row.MouseButton1Click:Connect(function()
			if not openBooth then return end
			local ok, result = pcall(function() return reserveFn:InvokeServer(openBooth, song.Number) end)
			if ok and type(result) == "table" and result.ok then
				say("Reserved - you're number " .. tostring(result.position), true)
			else
				say(type(result) == "table" and result.message or "Couldn't reserve that")
			end
		end)
	end
end

local function refreshQueue()
	if not openBooth then
		joinButton.Visible = false
		return
	end
	local ok, state = pcall(function() return stateFn:InvokeServer(openBooth) end)
	if not ok or type(state) ~= "table" then return end
	lastState = state
	local mine = nil
	for _, entry in ipairs(state.queue or {}) do if entry.userId == player.UserId then mine = entry end end
	local singing = state.isSinger == true
	book.Cancel.Visible = mine ~= nil
	book.Skip.Visible = state.current ~= nil and state.current.leadUserId == player.UserId
	if singing then
		queueLabel.Text = "You're singing now"
	elseif mine then
		queueLabel.Text = "You're number " .. tostring(mine.position) .. " in the queue"
	elseif state.playing and state.current then
		queueLabel.Text = tostring(state.current.leadName or "Someone") .. " is singing - " .. tostring(#(state.queue or {})) .. " waiting"
	else
		queueLabel.Text = "Nobody is singing - pick a song"
	end

	joinButton.Visible = gui.Enabled and state.canRequestJoin == true
	if state.joinRequestPending then
		joinButton.Visible = gui.Enabled
		joinButton.Text = "Join request pending…"
		joinButton.Active = false
	else
		joinButton.Text = "🎤 Request to join singer"
		joinButton.Active = true
	end

	local incoming = state.pendingJoinRequests and state.pendingJoinRequests[1] or nil
	if incoming then
		pendingJoinUserId = incoming.userId
		requestText.Text = tostring(incoming.name) .. " wants to sing with you"
		requestPanel.Visible = true
	else
		pendingJoinUserId = nil
		requestPanel.Visible = false
	end
end

local function reserve(number)
	if not openBooth then return end
	local ok, result = pcall(function() return reserveFn:InvokeServer(openBooth, number) end)
	if not ok or type(result) ~= "table" then say("Something went wrong, try again"); return end
	if result.ok then
		say("Reserved - you're number " .. tostring(result.position), true)
		numberBox.Text = ""
	else
		say(result.message or "Couldn't reserve that")
	end
	refreshQueue()
end

local function openBook(part)
	openBooth = part
	buildList()
	say("")
	refreshQueue()
	gui.Enabled = true
end

book.Close.MouseButton1Click:Connect(function()
	gui.Enabled = false
	joinButton.Visible = false
	-- Keep openBooth while the reservation/song is active so the lead singer
	-- can still receive approve/decline join requests after closing the book.
end)
book.Go.MouseButton1Click:Connect(function() reserve(numberBox.Text) end)
numberBox.FocusLost:Connect(function(enter) if enter then reserve(numberBox.Text) end end)
book.Cancel.MouseButton1Click:Connect(function()
	if openBooth then pcall(function() cancelFn:InvokeServer(openBooth) end); refreshQueue() end
end)
book.Skip.MouseButton1Click:Connect(function()
	if openBooth then pcall(function() skipFn:InvokeServer(openBooth) end); refreshQueue() end
end)
joinButton.MouseButton1Click:Connect(function()
	if not openBooth then return end
	local ok, result = pcall(function() return requestJoinFn:InvokeServer(openBooth) end)
	if ok and type(result) == "table" then say(result.message or (result.ok and "Join request sent" or "Couldn't request"), result.ok) end
	refreshQueue()
end)
approve.MouseButton1Click:Connect(function()
	if openBooth and pendingJoinUserId then pcall(function() respondJoinFn:InvokeServer(openBooth, pendingJoinUserId, true) end) end
	refreshQueue()
end)
decline.MouseButton1Click:Connect(function()
	if openBooth and pendingJoinUserId then pcall(function() respondJoinFn:InvokeServer(openBooth, pendingJoinUserId, false) end) end
	refreshQueue()
end)

local function boothFromPrompt(prompt)
	local holder = prompt.Parent
	if not holder or not holder:IsA("BasePart") then return nil end
	local link = holder:FindFirstChild("Screen")
	if link and link:IsA("ObjectValue") and link.Value then return link.Value end
	if CollectionService:HasTag(holder, TAG) then return holder end
	local best, bestDistance
	for _, part in ipairs(CollectionService:GetTagged(TAG)) do
		if part:IsA("BasePart") then
			local distance = (part.Position - holder.Position).Magnitude
			if not bestDistance or distance < bestDistance then best, bestDistance = part, distance end
		end
	end
	return best
end

changedEvent.OnClientEvent:Connect(function()
	if gui.Enabled then buildList() end
end)

task.spawn(function()
	local runtime = ReplicatedStorage:WaitForChild("KaraokeRuntime", 30)
	local value = runtime and runtime:WaitForChild("LibraryJson", 10)
	if value and value:IsA("StringValue") then
		value.Changed:Connect(function() if gui.Enabled then buildList() end end)
	end
end)

ProximityPromptService.PromptTriggered:Connect(function(prompt)
	if prompt.Name ~= "KaraokePrompt" then return end
	local booth = boothFromPrompt(prompt)
	if booth then openBook(booth) end
end)

task.spawn(function()
	while true do
		task.wait(1)
		if openBooth then refreshQueue() end
		refreshMicUi()
	end
end)
