-- EST Karaoke runtime song library.
-- Replace ReplicatedStorage.KaraokeSongs with this module.
-- It accepts the live Railway JSON written by KaraokeSync and remains
-- backwards-compatible with the old {time, "line"} lyric format.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local KaraokeSongs = {}

-- Optional Studio fallback songs. The live Railway catalog is authoritative
-- whenever KaraokeRuntime.LibraryJson contains songs.
KaraokeSongs.Songs = {}

local cachedRaw = nil
local cachedSongs = nil

local function runtimeValue()
	local folder = ReplicatedStorage:FindFirstChild("KaraokeRuntime")
	local value = folder and folder:FindFirstChild("LibraryJson")
	if value and value:IsA("StringValue") then
		return value
	end
	return nil
end

local function decodeRuntime()
	local value = runtimeValue()
	local raw = value and value.Value or ""
	if raw == cachedRaw and cachedSongs ~= nil then
		return cachedSongs
	end
	cachedRaw = raw
	cachedSongs = nil
	if raw == "" then
		return nil
	end
	local ok, data = pcall(function()
		return HttpService:JSONDecode(raw)
	end)
	if ok and type(data) == "table" and type(data.songs) == "table" then
		cachedSongs = data.songs
		return cachedSongs
	end
	return nil
end

function KaraokeSongs.all()
	local live = decodeRuntime()
	if live and #live > 0 then
		return live
	end
	return KaraokeSongs.Songs
end

function KaraokeSongs.find(number)
	for _, song in ipairs(KaraokeSongs.all()) do
		if tostring(song.Number) == tostring(number) then
			return song
		end
	end
	return nil
end

function KaraokeSongs.playable()
	local list = {}
	for _, song in ipairs(KaraokeSongs.all()) do
		if type(song.AudioId) == "string" and song.AudioId ~= "" then
			table.insert(list, song)
		end
	end
	return list
end

local function lineStart(line)
	if type(line) ~= "table" then return 0 end
	return tonumber(line.start or line.Start or line[1]) or 0
end

local function lineText(line)
	if type(line) ~= "table" then return "" end
	return tostring(line.text or line.Text or line[2] or "")
end

local function lineEnd(lyrics, index)
	local line = lyrics[index]
	local explicit = tonumber(type(line) == "table" and (line["end"] or line.finish or line.End) or nil)
	if explicit and explicit > lineStart(line) then return explicit end
	local nextLine = lyrics[index + 1]
	if nextLine then
		local nextStart = lineStart(nextLine)
		if nextStart > lineStart(line) then return nextStart end
	end
	return lineStart(line) + 4
end

function KaraokeSongs.lineAt(song, seconds)
	local lyrics = song and song.Lyrics
	if type(lyrics) ~= "table" or #lyrics == 0 then return nil end
	local index = 0
	for i, line in ipairs(lyrics) do
		if lineStart(line) <= seconds then index = i else break end
	end
	if index == 0 then
		return 0, nil, lyrics[1] and lineText(lyrics[1]) or nil
	end
	return index,
		lyrics[index] and lineText(lyrics[index]) or nil,
		lyrics[index + 1] and lineText(lyrics[index + 1]) or nil,
		lyrics[index - 1] and lineText(lyrics[index - 1]) or nil
end

local function wordProgress(line, seconds, finish)
	local words = type(line) == "table" and (line.words or line.Words) or nil
	if type(words) ~= "table" or #words == 0 then
		local startAt = lineStart(line)
		local span = math.max(0.05, finish - startAt)
		return math.clamp((seconds - startAt) / span, 0, 1)
	end

	local totalChars = 0
	for i, word in ipairs(words) do
		local text = tostring(type(word) == "table" and (word.text or word.Text or word[1]) or word)
		totalChars += #text
		if i < #words then totalChars += 1 end
	end
	totalChars = math.max(1, totalChars)

	local doneChars = 0
	for i, word in ipairs(words) do
		local text = tostring(type(word) == "table" and (word.text or word.Text or word[1]) or word)
		local startAt = tonumber(type(word) == "table" and (word.start or word.Start or word[2]) or nil) or lineStart(line)
		local endAt = tonumber(type(word) == "table" and (word["end"] or word.finish or word.End or word[3]) or nil) or finish
		if seconds >= endAt then
			doneChars += #text
			if i < #words then doneChars += 1 end
		elseif seconds > startAt then
			local alpha = math.clamp((seconds - startAt) / math.max(0.05, endAt - startAt), 0, 1)
			doneChars += #text * alpha
			break
		else
			break
		end
	end
	return math.clamp(doneChars / totalChars, 0, 1)
end

function KaraokeSongs.karaokeAt(song, seconds)
	local lyrics = song and song.Lyrics
	if type(lyrics) ~= "table" or #lyrics == 0 then return nil end
	local index = 0
	for i, line in ipairs(lyrics) do
		if lineStart(line) <= seconds then index = i else break end
	end
	if index == 0 then
		return {
			index = 0,
			current = "",
			next = lineText(lyrics[1]),
			previous = "",
			progress = 0,
		}
	end
	local currentLine = lyrics[index]
	local finish = lineEnd(lyrics, index)
	return {
		index = index,
		current = lineText(currentLine),
		next = lyrics[index + 1] and lineText(lyrics[index + 1]) or "",
		previous = lyrics[index - 1] and lineText(lyrics[index - 1]) or "",
		progress = wordProgress(currentLine, seconds, finish),
		start = lineStart(currentLine),
		finish = finish,
	}
end

return KaraokeSongs
