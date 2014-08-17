var request = require('request');
var runSeries = require('run-series');
var through = require('through2');
var path = require('path');
var flat = require('flat-file-db');
var log = require('single-line-log').stdout;
var split = require('binary-split');

module.exports = function(dat, cb) {
  cb()
  var db = flat.sync('./sync.db');
  var seq = db.get('seq');
  
  if (seq) console.log('last seq', seq);
  
  // haha
  setInterval(function() {
    if (seq) db.put('seq', seq);
  }, 10000);
  
  update();
  
  function update() {
    console.log('creating changes stream...');
    var count = 0;
    
    var reqUrl = 'https://skimdb.npmjs.com/registry/_changes?heartbeat=30000&include_docs=true&feed=continuous' + (seq ? '&since=' + seq : '');
    console.log(reqUrl);
    var changes = request(reqUrl);
    
    changes.pipe(split()).pipe(through.obj({highWaterMark: 20}, function(data, enc, cb) {
      data = JSON.parse(data);
      var doc = data.doc;
      
      changes.on('finish', update);
      changes.on('error', update);
      
      // dat uses .key
      doc.key = doc._id;
      delete doc._id;
      
      // dat reserves .version, and .version shouldn't be on top level of npm docs anyway
      delete doc.version
      
      // keep the seq around because why not
      doc.couchSeq = seq = data.seq;
      
      dat.get(doc.id, function(err, existing) {
        if (err) return put();
        getAttachments(existing);
      })
      
      function put() {
        dat.put(doc, function(err, latest) {
          if (err) {
            console.error('PUT ERR!', doc, err);
            return cb();
          }
          getAttachments(latest);
        });
      }
      
      function getAttachments(latest) {
        if (!latest.versions) return cb()
        var versions = Object.keys(latest.versions);
      
        // fetch all attachments
        var fns = [];
        versions.map(function(version) {
          var filename = latest.name + '-' + version + '.tgz';
          var tgz = latest.versions[version].dist.tarball;
          if (!tgz) return console.log(latest.name, version, 'has no dist.tarball');
          if (latest.attachments && latest.attachments[filename]) return console.log(filename, 'already in doc');
          
          fns.push(getAttachment);
          
          function getAttachment(cb) {
          
            var ws = dat.createBlobWriteStream(filename, latest, function(err, updated) {
              if (err) return cb(err);
              latest = updated;
              cb();
            })
          
            console.log('tgz GET', tgz);
            var req = request(tgz);
            req.on('error', function(err) {
              console.error('ERROR fetching', tgz, err);
              cb();
            })
            req.pipe(ws);
          }
        })
      
        runSeries(fns, function(err, results) {
          if (err) console.error('GET ERROR!', err);
          console.log(++count, [latest.id, latest.version]);
          cb();
        })
      };
       
    }));
    
  };
}