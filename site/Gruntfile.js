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
    }
  });
  grunt.loadNpmTasks('grunt-wintersmith');

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

