-- EST Karaoke Railway -> Roblox live library bridge.
-- Put this Script in ServerScriptService.
-- Set Script Attributes instead of editing secrets into source:
--   BaseUrl       string  https://YOUR-EST-KARAOKE-SERVICE.up.railway.app
--   GameSyncToken string  same secret as Railway GAME_SYNC_TOKEN
--   PollSeconds   number  optional, default 20

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local DataStoreService = game:GetService("DataStoreService")

local BASE_URL = tostring(script:GetAttribute("BaseUrl") or "")
local TOKEN = tostring(script:GetAttribute("GameSyncToken") or "")
local POLL_SECONDS = math.max(10, tonumber(script:GetAttribute("PollSeconds")) or 20)

if BASE_URL == "" then
	warn("[KaraokeSync] Set the BaseUrl attribute on this script.")
end
if TOKEN == "" then
	warn("[KaraokeSync] Set the GameSyncToken attribute on this script.")
end

BASE_URL = string.gsub(BASE_URL, "/+$", "")

local runtime = ReplicatedStorage:FindFirstChild("KaraokeRuntime")
if not runtime then
	runtime = Instance.new("Folder")
	runtime.Name = "KaraokeRuntime"
	runtime.Parent = ReplicatedStorage
end

local function stringValue(name)
	local value = runtime:FindFirstChild(name)
	if not value then
		value = Instance.new("StringValue")
		value.Name = name
		value.Parent = runtime
	end
	return value
end

local libraryJson = stringValue("LibraryJson")
local statusValue = stringValue("Status")
local sourceValue = stringValue("Source")

local cacheStore = DataStoreService:GetDataStore("EST_KaraokeLiveCache_v2")
local CACHE_KEY = "LastGoodLibrary"

local function useBody(body, source)
	local ok, data = pcall(function() return HttpService:JSONDecode(body) end)
	if not ok or type(data) ~= "table" or type(data.songs) ~= "table" then
		return false, "Invalid library JSON"
	end
	libraryJson.Value = body
	sourceValue.Value = source
	statusValue.Value = string.format("%d song(s)", #data.songs)
	return true, data
end

local function restoreCache()
	local ok, cached = pcall(function() return cacheStore:GetAsync(CACHE_KEY) end)
	if ok and type(cached) == "string" and cached ~= "" then
		local used, data = useBody(cached, "Cached")
		if used then print(string.format("[KaraokeSync] restored %d song(s) from DataStore", #data.songs)) end
	elseif not ok then
		warn("[KaraokeSync] cache restore failed: " .. tostring(cached))
	end
end

local lastSaved = nil
local function saveCache(body)
	if body == lastSaved then return end
	if #body > 3500000 then
		warn("[KaraokeSync] library cache is too large for the single-key safety cache")
		return
	end
	local ok, err = pcall(function() cacheStore:SetAsync(CACHE_KEY, body) end)
	if ok then
		lastSaved = body
	else
		warn("[KaraokeSync] cache save failed: " .. tostring(err))
	end
end

local function fetchLive()
	if BASE_URL == "" or TOKEN == "" then return false end
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. "/api/game/library",
			Method = "GET",
			Headers = { Authorization = "Bearer " .. TOKEN },
		})
	end)
	if not ok then
		statusValue.Value = "Network error"
		return false
	end
	if not response.Success then
		statusValue.Value = "HTTP " .. tostring(response.StatusCode)
		return false
	end
	local changed = response.Body ~= libraryJson.Value
	local used, data = useBody(response.Body, "Live")
	if not used then return false end
	if changed then
		task.spawn(saveCache, response.Body)
		print(string.format("[KaraokeSync] synced %d song(s)", #data.songs))
	end
	return true
end

restoreCache()
while true do
	fetchLive()
	task.wait(POLL_SECONDS)
end
