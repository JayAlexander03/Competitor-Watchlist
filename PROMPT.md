We are trying to build a competitor watchlist application in the exploration and mining industry. This is similar to a news feed and news letter, but only for specific projects of interest.

 This is the basic function of the application and also the search tab. The app should let the user enter the company name and the project name. The application will then provide the following information related to that company and their project:

 - Source of release: Company Webpage, SEDAR, News Site,etc.
 - Release date: DD-MMM-YYYY (e.g. 01-JAN-2024)
 - Release content: Title of the release.
 - Release link: URL of the release.

It should be at most 3 of the latest releases being displayed.

 The second function is the watchlist tab. 

 The app should also allow the user to add the project to a watchlist from the search tab. The purpose of the search tab is to allow the user verify the information of a company and their project before adding it to the watchlist. The app will also allow the user to remove projects from the watchlist.
 
 If a project was added to the watchlist, the application will check all of the information for that project. All of the information (Company releases, News Site releases, SEDAR releases, etc.) will be displayed in the watchlist tab. The application will do a daily check to update the information. 
 
 Multiple projects could exist for a company, so the application should be able to distinguish the correct project information from the releases before displaying the information in the watchlist tab. We can use AI to help with this.

 The third function is the notification tab. The user will be notified when there is a new release. The user can set up notifications to receive email alerts when there is a new release for a certain project. The app could use my Outlook email to send the new releases from the watchlist. An email list will be inputted by the user.

For now, plan the architecture, components, routes, data flow, and implementation steps. We will be using the AI SDK with OpenRouter for interference. Let us make the application without too much external dependencies.


