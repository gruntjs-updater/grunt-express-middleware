'use strict';

var path = require('path');
var temp = require('temp');
var open = require('open');
var _ = require('lodash');
var connect = require('connect');

var util = require('../lib/util');

function monitorChildProcess(child, callback) {
    child.child.stdout.on('data', function(data) {
        if (new RegExp('\\[pid: ' + child.child.pid + '\\][\\n\\r]*$').test(data.toString())) {
            callback();
        }
    });
}

module.exports = function(grunt) {
    var DefaultLiveReloadPort = 35729;
    var watchDir = temp.mkdirSync('express');
    var serverMap = {};
    var parentcwd = process.cwd();

    // get npmTasks from grunt-express, not the parent Gruntfile
    process.chdir(path.join(__dirname, '../'));

    if (!grunt.task._tasks['watch']) {
        grunt.loadNpmTasks('grunt-contrib-watch');
    }

    if (!grunt.task._tasks['parallel']) {
        grunt.loadNpmTasks('grunt-parallel');
    }

    process.chdir(parentcwd);

    grunt.registerMultiTask('express', function() {
        var thisTarget = this.target;

        // change default server to express, instead of connect
        grunt.config.set('express.options.server', path.resolve(__dirname, '..', 'lib', 'express.js'));

        var options = this.options({
            serverreload: false,
            livereload: null,
            open: false
        });

        serverMap[thisTarget] = options.serverKey = path.resolve(watchDir, thisTarget + '.server');
        util.touchFile(options.serverKey);

        if (options.bases) {
            if (!Array.isArray(options.bases)) {
                grunt.config.set('express.' + thisTarget + '.options.bases', [options.bases]);
                options.bases = [options.bases];
            };

            // wrap each path in connect.static middleware
            options.bases = _.map(options.bases, function(b) {
                return path.resolve(b);
            });
        };

        if (options.livereload) {
        	options.livereload = _.defaults(options.livereload, {
        		port: DefaultLiveReloadPort,
        		watch: options.bases || []
        	});
        	grunt.config.set('express.' + thisTarget + '.options.livereload', options.livereload.port);
        };
        if (options.livereload) {
            // dynamically add `grunt-contrib-watch` task to manage livereload of static `bases`
            grunt.config.set('watch.' + util.makeServerTaskName(thisTarget, 'livereload'), {
                files: _.map(options.livereload.watch, function(base) {
                    return base + '/**/*.*';
                }),
                options: {
                    livereload: options.livereload.port
                }
            });
        };

        if (options.serverreload) {
            var watcherOptions = {
                interrupt: true,
                atBegin: true,
                event: ['added', 'changed']
            };

            var watching = 'undefined' !== typeof grunt.task._tasks.watch || 'undefined' !== typeof grunt.config.data.watch;
            // make sure `grunt-contrib-watch` task is loaded
            if (!watching) {
                grunt.loadNpmTasks('grunt-contrib-watch');
            }

            // dynamically add `grunt-contrib-watch` task to manage `grunt-express` sub task
            grunt.config.set('watch.' + util.makeServerTaskName(thisTarget, 'server'), {
                files: options.serverKey,
                tasks: [
                    ['express-server', thisTarget, options.serverKey].join(':'), 'express-keepalive'
                ],
                options: _.extend({}, options.watch, watcherOptions)
            });

            if (_.filter(grunt.task._queue, function(task) {
                return !task.placeholder && task.task.name === 'watch';
            }).length === 0) {
                if (options.livereload) {
                    var serverReloadTask = 'express-watch-server:' + thisTarget + ':' + options.serverKey,
                        liveReloadTask = 'express-watch-livereload:' + options.bases.join(',') + ':' + thisTarget + ':' + options.livereload,
                        parallelTask = 'parallel.' + util.makeServerTaskName(thisTarget, 'server');

                    grunt.config.set(parallelTask, {
                        tasks: [serverReloadTask, liveReloadTask],
                        options: {
                            stream: true,
                            grunt: true
                        }
                    });

                    grunt.task.run(parallelTask.replace('.', ':'));
                } else {
                    grunt.task.run('watch');
                }
            }
        } else {
            grunt.task.run(['express-server', thisTarget].join(':'));
        }
    });

    grunt.registerTask('express-watch-livereload', 'wrapper for watch task, for running with grunt-parallel', function(bases, target, port) {
        // dynamically add `grunt-contrib-watch` task to manage livereload of static `bases`
        var taskName = 'watch.' + util.makeServerTaskName(target, 'livereload');
        bases = bases.split(',');
        port = parseInt(port) || DefaultLiveReloadPort;

        grunt.config.set(taskName, {
            files: _.map(bases, function(base) {
                return base + '/**/*.*';
            }),
            options: {
                livereload: port,
                interrupt: true
            }
        });
        grunt.task.run(taskName.replace('.', ':'));
    });

    grunt.registerTask('express-watch-server', 'wrapper for watch task, for running with grunt-parallel', function(target, serverKey) {
        var taskName = 'watch.' + util.makeServerTaskName(target, 'server'),
            options = grunt.config.get('express');

        var watcherOptions = {
            interrupt: true,
            atBegin: true,
            event: ['added', 'changed']
        };
        // dynamically add `grunt-contrib-watch` task to manage `grunt-express` sub task
        grunt.config.set(taskName, {
            files: serverKey,
            tasks: [
                ['express-server', target, serverKey].join(':'), 'express-keepalive'
            ],
            options: _.extend({}, options.watch, watcherOptions)
        });

        grunt.task.run(taskName.replace('.', ':'));
    });

    grunt.registerTask('express-start', 'Start the server (or restart if already started)', function(target) {
        util.touchFile(serverMap[target]);
    });
    // alias, backward compatibility
    grunt.registerTask('express-restart', 'Restart the server (or start if not already started)', ['express-start']);

    grunt.registerTask('express-server', function(target) {
        var self = this;
        var options = _.extend({}, grunt.config.get('express.options'), grunt.config.get('express.' + target + '.options'));
        options = _.defaults(options, {
        	hostname: 'localhost',
            port: 8080
        })

        if (options.livereload) {
        	options.livereload = _.defaults(options.livereload, {
        		port: DefaultLiveReloadPort,
        		watch: options.bases || []
        	});
        };

        if (options.serverreload) {
            util.watchModule(function(oldStat, newStat) {
                if (newStat.mtime.getTime() !== oldStat.mtime.getTime()) {
                    util.touchFile(self.args[1]);
                }
            });
        }

        var done = this.async();

        util.runServer(grunt, options).on('startListening', function(server, app) {
            // ekit
            // add power middleware
            options.middleware = options.middleware || function() {};
            options.middleware(app);

            var address = server.address();
            var serverPort = address.port;
            if (serverPort !== options.port) {
                grunt.config.set('express.' + target + '.options.port', serverPort);
            }

            if (options.open === true) {
                // https://github.com/joyent/node/blob/master/lib/_tls_wrap.js#L464
                var protocol = (!server.pfx && (!server.cert || !server.key)) ? 'http' : 'https';
                console.log(address)
                var hostname = address.address || 'localhost';
                if (hostname === '0.0.0.0') {
                    hostname = 'localhost';
                }
                open(protocol + '://' + hostname + ':' + address.port);
            } else if (typeof options.open === 'string') {
                open(options.open);
            }

            grunt.event.emit('express:' + target + ':started');
            done();
        });
    });

    grunt.registerTask('express-keepalive', 'Keep grunt running', function() {
        this.async();
    });
};