import os
import json
import time
import httpx
import base64
import asyncio
import psycopg2
import functools
from pprint import pformat
from dotenv import load_dotenv
from psycopg2.extras import execute_values

load_dotenv()

def timer_decorator(func):
    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            start_time = time.time()
            result = await func(*args, **kwargs)
            end_time = time.time()
            print(f"{func.__name__} took {end_time - start_time:.4f} seconds")
            return result
    else:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.time()
            result = func(*args, **kwargs)
            end_time = time.time()
            print(f"{func.__name__} took {end_time - start_time:.4f} seconds")
            return result
    return wrapper

class PostgresClient:
    def __init__(self, log=None):
        self.connection = None
        self.cursor = None
        self.log=log
    
    def __enter__(self):
        self.connection = psycopg2.connect(
            host=os.getenv("PG_HOST"),
            dbname=os.getenv("PG_DB_NAME"),
            user=os.getenv("PG_USER")
        )
        self.cursor = self.connection.cursor()
        return self
    
    def __exit__(self, exc_type, exc_value, traceback):
        if self.cursor:
            self.cursor.close()
        if self.connection:
            self.connection.commit()
            self.connection.close()
    
    def query(self, query, data=None, fetchall=False):
        try:
            if data:
                execute_values(self.cursor, query, data)
            else:
                self.cursor.execute(query)
            if fetchall:
                return self.cursor.fetchall()
        except Exception as e:
            self.log(1, f"Database error: {e}")
            raise

class LastFmClient:
    def __init__(self, log=None):
        self.last_req_time = None
        self.base_url = "http://ws.audioscrobbler.com/2.0/"
        self.api_resp_format = "&format=json"
        # FIXME: Securely access secrets
        self.apikey = os.getenv("LASTFM_API_KEY")
        self.log = log

    async def get(self, endpoint, params, max_retries=3):
        url_req = self.base_url + "?method=" + endpoint
        for p in params:
            url_req += f"&{p}"
        url_req += f"&{self.api_resp_format}&api_key={self.apikey}"
        self.log(0, f"LastFM Request: {url_req}")
        try:
            for attempt in range(max_retries):
                if self.last_req_time is not None:
                    elapsed = time.time() - self.last_req_time
                    if elapsed < 1:
                        time.sleep(1 - elapsed)
                async with httpx.AsyncClient() as client:
                    response = await client.get(url_req)
                    self.last_req_time = time.time()
                    # Handle rate limiter
                    if response.status_code == 429:
                        self.log(2, f"Rate limit exceeded, headers: {pformat(dict(response.headers))}")
                        retry_after = response.headers.get("retry-after")
                        if retry_after:
                            wait_time = int(retry_after) / 1000
                            self.log(2, f"Rate limit exceeded. Retrying after {wait_time} secs...")
                            await asyncio.sleep(wait_time)
                        else:
                            self.log(1, f"Rate limit exceeded. but retry-after header not found.")
                            raise Exception("RATE LIMIT EXCEEDED")
                    else:
                        return response
            raise Exception(f"RETRIES EXCEEDED > {max_retries}")
        except Exception as e:
            self.log(1, f"ERROR: Failed to send lastfm request: {e}")
            return -1

class SpotifyClient:
    def __init__(self, log=None):
        self.last_req_time = None
        self.access_token = None
        self.base_url = "https://api.spotify.com/v1"
        self.log = log

    async def init_access_token(self):
        # FIXME: Securely access secrets
        spotify_client_id = os.getenv("SPOTIFY_CLIENT_ID")
        spotify_client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
        url_req = 'https://accounts.spotify.com/api/token'
        payload = { 'grant_type': 'client_credentials' }
        credentials = f'{spotify_client_id}:{spotify_client_secret}'
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': f'Basic {encoded_credentials}'
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(url_req, data=payload, headers=headers)
        if response.status_code == 200:
            self.access_token = response.json()['access_token']
        else:
            self.log(1, f'Error fetching access token, Status code {response.status_code}: {response.text}')

    async def get(self, endpoint, params, max_retries=3):
        url_req = self.base_url + endpoint
        for p in params:
            url_req += f"{p}&"
        url = url_req.rstrip("&")
        try:
            for attempt in range(max_retries):
                # reassign access token each time inorder to keep update with each retry
                headers = { 'Authorization': f'Bearer {self.access_token}' }
                if self.last_req_time is not None:
                    elapsed = time.time() - self.last_req_time
                    if elapsed < 2:
                        time.sleep(2 - elapsed)
                async with httpx.AsyncClient() as client:
                    self.log(0, f"Spotify Request: {url}")
                    response = await client.get(url, headers=headers)
                    self.last_req_time = time.time()
                    # Handle rate limiting
                    if response.status_code == 429:
                        retry_after = response.headers.get("retry-after")
                        if retry_after:
                            wait_time = int(retry_after)
                            self.log(2, f"Rate limit exceeded. Retrying after {wait_time} secs...")
                            await asyncio.sleep(wait_time)
                        else:
                            self.log(1, f"Rate limit exceeded. but retry-after header not found.")
                            raise Exception("RATE LIMIT EXCEEDED")
                    # Handle expired access token
                    elif response.status_code == 401:
                        await self.init_access_token()
                    else:
                        return response
            raise Exception(f"RETRIES EXCEEDED > {max_retries}")
        except Exception as e:
            self.log(1, f"ERROR: Failed to send spotify request: {e}")
            return -1

class Artist:
    def __init__(self, id=None, name=None, lastfm_url=None, spotify_id=None, spotify_popular=None, dictionary=None):
        if dictionary is None:
            self.id = id
            self.name = name
            self.lastfm_url = lastfm_url
            self.spotify_id = spotify_id
            self.spotify_popular = spotify_popular
        else:
            for key, value in dictionary.items():
                setattr(self, key, value)
    
    def asdict(self):
        return {
            'name': self.name,
            'lastfm_url': self.lastfm_url,
            'spotify_id': self.spotify_id,
            'spotify_popular': self.spotify_popular,
        }

    # !!! ORDER OF VALUES IN TUPLE MUST MATCH PSQL QUERY ORDER IN aggregatorArtist.save_artists_to_db() !!!
    def to_tuple(self):
        return (self.name, self.spotify_id, self.spotify_popular, self.lastfm_url)

class Album:
    def __init__(self, id=None, title=None, spotifyexternalid=None, spotifypopularity=None, lastfmurl=None, artistid=None, genres=None):
        self.id = id
        self.title = title
        self.spotify_id = spotifyexternalid
        self.spotify_popular = spotifypopularity
        self.lastfm_url = lastfmurl
        self.artist_id = artistid
        self.genres = genres

    # !!! ORDER OF VALUES IN TUPLE MUST MATCH PSQL QUERY ORDER IN aggregatorAlbum.save_albums_to_db() !!!
    def to_tuple(self):
        return (self.title, self.spotify_id, self.lastfm_url, self.artist_id)

class Song:
    def __init__(self, title=None, artistid=None, albumid=None, albumtracknum=None, spotifyexternalid=None, spotifypopularity=None, spotifypreviewurl=None, lastfmurl=None, yturl=None):
        self.title = title
        self.artist_id = artistid
        self.album_id = albumid
        self.track_num = albumtracknum
        self.spotify_id = spotifyexternalid
        self.spotify_popular = spotifypopularity
        self.spotify_preview_url = spotifypreviewurl
        self.lastfm_url = lastfmurl
        self.yt_url = yturl
    
    def to_tuple():
        # !!! ORDER OF VALUES IN TUPLE MUST MATCH PSQL QUERY ORDER IN aggregatorSong.save_songs_to_db() !!!
        return (self.title, self.artist_id, self.album_id, self.track_num, self.spotify_id, self.spotify_preview_url, self.lastfm_url)