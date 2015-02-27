module.exports = function(grunt) {
  grunt.initConfig({
    wintersmith: {
      production: {
        options: {
          config: './config.json'
        }
      },
      preview: {
        options: {
          action: "preview",
          config: './config.json'
        }
      }
    },
    rsync: {
      options: {
        recursive: true
      },
      production: {
        options: {
          src: "./build/",
          dest: "~/public_html",
          host: "mountai8@mountainwerks.org"
        }
      }
    }
  });
  grunt.loadNpmTasks('grunt-wintersmith');
  grunt.loadNpmTasks('grunt-rsync');

  grunt.registerTask('preview', [
    'wintersmith:preview'
  ]);

  grunt.registerTask('build', [
    'wintersmith:production'
  ]);

  grunt.registerTask('deploy', [
    'rsync:production'
  ]);

};

