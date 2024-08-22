const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PG_USER,
  database: process.env.PG_DB_NAME,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
});
/*
  This is how were gonna do it: the client will recieve a cache of default songs on
  loading page. Then the cache will be updated based on velocity of scroll and
  change in filter params requests.

  // params that are always needed are events date range 
  // acting as the data's pager. Then certain where conditions
  // are dynamically added based on filter list not empty (ex:
  // exclude_artists = ['a', 'b'] and only_venue_names = [''])
  
  SELECT Artists.Name, *.Songs, *.Events FROM Songs
  JOIN Artists ON Artists.ID = Songs.ArtistID

  JOIN EventsArtists ON EventsArtists.ArtistID = Artists.ID
  JOIN Events ON Events.ID = EventsArtists.EventID
  WHERE Events.EventDate >= (MIN_DATE_RANGE) 
  AND Events.EventDate <= (MAX_DATE_RANGE)
  
  // not these artists
  AND Artists.Name NOT IN (:excluded_names)
  // only these artists
  AND Artists.Name IN (:only_names)
  // by venue name
  AND Events.Venue
  // with in certain radius
  AND (
    <distance_calculation_logic_using_latitude_and_longitude> <= <radius_in_meters>
  )  
*/
 
 const MAX_PAGE_SIZE = 200;
 const DEFAULT_PAGE_SIZE = 100;
 const OrderBys = Object.freeze({
   ARTIST: 'a.Name',
   SONG_NAME: 'Songs.Name',
   EVENT_DATE: 'e.Date',
   VENUE_NAME: 'v.Name'
  });

const reqQueryParamsCleaner = (req, res, next) => {
  try {
    const { page, limit, filters } = req.body;
    const pageSize = Math.min(MAX_PAGE_SIZE, parseInt(limit) || DEFAULT_PAGE_SIZE);
    const pageNum = parseInt(page) || 0;
    let orderBy = filters.orderBy || 0;
    switch (orderBy) {
      case 1:
        orderBy = OrderBys.SONG_NAME;
        break;
      case 2:
        orderBy = OrderBys.EVENT_DATE;
        break;
      case 3:
        orderBy = OrderBys.VENUE_NAME;
        break;
      default:
        orderBy = OrderBys.ARTIST;
    }
    req.cParams = [pageSize, pageNum, orderBy];
    next();
  } catch (err) {
    next(err);
  }
};

const querySongsList = async (whereConditional, queryParms) => {
  const client = await pool.connect();
  // query = `
  //     SELECT a.Name as Artist, Songs.Title, v.Name as Venue, e.EventDate, v.Hood, v.VenueAddress FROM Songs
  //     JOIN Artists AS a ON a.ID = Songs.ArtistID
  //     JOIN EventsArtists AS ea ON ea.ArtistID = a.ID
  //     JOIN Events AS e ON e.ID = ea.EventID
  //     JOIN Venues AS v ON v.ID = e.VenueID
  //     ${whereConditional}
  //     ORDER BY $3
  //     LIMIT $1 OFFSET $2;
  // `;
  query = `
    WITH data AS (
      SELECT a.Name AS Artist, Songs.Title, v.Name AS Venue, e.EventDate, v.Hood, v.VenueAddress FROM Songs
      JOIN Artists AS a ON a.ID = Songs.ArtistID
      JOIN EventsArtists AS ea ON ea.ArtistID = a.ID
      JOIN Events AS e ON e.ID = ea.EventID
      JOIN Venues AS v ON v.ID = e.VenueID
      ${whereConditional}
      ORDER BY $3
      LIMIT $1 OFFSET $2
    ),
    total_count AS (
        SELECT COUNT(*) AS total FROM Songs
        JOIN Artists AS a ON a.ID = Songs.ArtistID
        JOIN EventsArtists AS ea ON ea.ArtistID = a.ID
        JOIN Events AS e ON e.ID = ea.EventID
        JOIN Venues AS v ON v.ID = e.VenueID
        ${whereConditional}
    )
    SELECT data.*, total_count.total FROM data, total_count;
  `;
  // console.log('SELECT_SONGS_QUERY: ' + query)
  // console.log('QUERY_PARAMS: ' + queryParms)
  const result = await client.query(query, queryParms);
  client.release();
  return result;
};

const whereConditionBuilder = async (req, res, next) => {
  try {
    let whereConditional = 'WHERE ';

    const { filters } = req.body;
    if(filters.ex.minDate != '' && filters.ex.maxDate != '') whereConditional += `e.EventDate NOT BETWEEN '${ (new Date(filters.ex.minDate)).toUTCString() }' AND '${ (new Date(filters.ex.maxDate)).toUTCString() }' AND `;
    if(filters.req.minDate != '' && filters.req.maxDate != '') whereConditional += `e.EventDate BETWEEN '${ (new Date(filters.req.minDate)).toUTCString() }' AND '${ (new Date(filters.req.maxDate)).toUTCString() }' AND `;
    if(filters.ex.dates.length) whereConditional += `e.EventDate NOT IN ('${filters.ex.dates.join(`', '`)}') AND `;
    if(filters.req.dates.length) whereConditional += `e.EventDate IN ('${filters.req.dates.join(`', '`)}') AND `;
    if(filters.ex.artists.length) whereConditional += `a.Name NOT IN ('${filters.ex.artists.join(`', '`)}') AND `;
    if(filters.req.artists.length) whereConditional += `a.Name IN ('${filters.req.artists.join(`', '`)}') AND `;
    if(filters.ex.venues.length) whereConditional += `v.Name NOT IN ('${filters.ex.venues.join(`', '`)}') AND `;
    if(filters.req.venues.length) whereConditional += `v.Name IN ('${filters.req.venues.join(`', '`)}') AND `;
    if(filters.ex.songs.length) whereConditional += `Songs.Name NOT IN ('${filters.ex.songs.join(`', '`)}') AND `;
    if(filters.req.songs.length) whereConditional += `Songs.Name IN ('${filters.req.songs.join(`', '`)}') AND `;
    if(filters.ex.hoods.length) whereConditional += `v.Hood NOT IN ('${filters.ex.hoods.join(`', '`)}') AND `;
    if(filters.req.hoods.length) whereConditional += `v.Hood IN ('${filters.req.hoods.join(`', '`)}') AND `;
    // remove trailing 'AND'
    whereConditional = whereConditional.substring(0, whereConditional.length - 4);
    req.whereConditional = whereConditional;
    next();
  } catch (err) {
    next(err);
  }
};


const router = express.Router();
// Optimize TODO (potential): SETUP CACHE OF songs list to avoid many sql requests
router.post('/', reqQueryParamsCleaner, whereConditionBuilder, async (req, res, next) => {
  try {
    const result = await querySongsList(req.whereConditional ,req.cParams);
    const songsList = result.rows;
    // console.log(songsList)
    res.json(songsList);
  } catch (err) {
    next(err);
  }
});

router.post('/save-list', async (req, res, next) => {
  try {
    const client = await pool.connect();
    let whereConditional = 'WHERE ';
    const { filters } = req.body;
    if(filters.ex.minDate != '' && filters.ex.maxDate != '') whereConditional += `e.EventDate NOT BETWEEN '${ (new Date(filters.ex.minDate)).toUTCString() }' AND '${ (new Date(filters.ex.maxDate)).toUTCString() }' AND `;
    if(filters.req.minDate != '' && filters.req.maxDate != '') whereConditional += `e.EventDate BETWEEN '${ (new Date(filters.req.minDate)).toUTCString() }' AND '${ (new Date(filters.req.maxDate)).toUTCString() }' AND `;
    if(filters.ex.dates.length) whereConditional += `e.EventDate NOT IN ('${filters.ex.dates.join(`', '`)}') AND `;
    if(filters.req.dates.length) whereConditional += `e.EventDate IN ('${filters.req.dates.join(`', '`)}') AND `;
    if(filters.ex.artists.length) whereConditional += `a.Name NOT IN ('${filters.ex.artists.join(`', '`)}') AND `;
    if(filters.req.artists.length) whereConditional += `a.Name IN ('${filters.req.artists.join(`', '`)}') AND `;
    if(filters.ex.venues.length) whereConditional += `v.Name NOT IN ('${filters.ex.venues.join(`', '`)}') AND `;
    if(filters.req.venues.length) whereConditional += `v.Name IN ('${filters.req.venues.join(`', '`)}') AND `;
    if(filters.ex.songs.length) whereConditional += `Songs.Name NOT IN ('${filters.ex.songs.join(`', '`)}') AND `;
    if(filters.req.songs.length) whereConditional += `Songs.Name IN ('${filters.req.songs.join(`', '`)}') AND `;
    if(filters.ex.hoods.length) whereConditional += `v.Hood NOT IN ('${filters.ex.hoods.join(`', '`)}') AND `;
    if(filters.req.hoods.length) whereConditional += `v.Hood IN ('${filters.req.hoods.join(`', '`)}') AND `;
    // remove trailing 'AND'
    whereConditional = whereConditional.substring(0, whereConditional.length - 4);
    req.whereConditional = whereConditional;
    let orderBy = filters.orderBy || 0;
    switch (orderBy) {
      case 1:
        orderBy = OrderBys.SONG_NAME;
        break;
      case 2:
        orderBy = OrderBys.EVENT_DATE;
        break;
      case 3:
        orderBy = OrderBys.VENUE_NAME;
        break;
      default:
        orderBy = OrderBys.ARTIST;
    }
    query = `
      SELECT a.Name as Artist, Songs.Title, Songs.SpotifyId FROM Songs
      JOIN Artists AS a ON a.ID = Songs.ArtistID
      JOIN EventsArtists AS ea ON ea.ArtistID = a.ID
      JOIN Events AS e ON e.ID = ea.EventID
      JOIN Venues AS v ON v.ID = e.VenueID
      ${whereConditional}
      ORDER BY $1;
    `;
    // console.log('SELECT_SONGS_QUERY: ' + query)
    const result = await client.query(query, [orderBy]);
    client.release();
    res.songs = result.rows;

  } catch (err) { next(err); }
  
});

module.exports = router;